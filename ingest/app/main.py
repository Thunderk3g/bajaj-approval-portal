"""reconciliation-ingest — the parsing and staging service.

Called only by the Next.js app, over the internal network, with a shared secret.
It has no session concept, no user-facing route, and never authenticates a
human — Better Auth owns that, and splitting an auth boundary across two
services is how you end up with two answers to "who is this".
"""

from __future__ import annotations

import hmac
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import psycopg
from fastapi import BackgroundTasks, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db, jobs
from .config import Config, ConfigError, load_config
from .proofs import inspect

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("ingest")

config: Config | None = None

_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _is_uuid(value: str | None) -> bool:
    return bool(value) and bool(_UUID.match(value))  # type: ignore[arg-type]
#: Parsing is CPU-bound and releases the GIL inside calamine/pyxlsb, so a small
#: pool is enough. Two: one long Lead Dump stream plus one interactive parse.
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ingest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global config
    config = load_config()
    db.init_pool(config.database_url)

    # Refuses to serve against a database that does not match what it writes.
    # Failing here is far kinder than failing on the admin's first upload.
    db.verify_schema()

    reaped = db.reap_stale_jobs(config.stale_job_seconds)
    if reaped:
        log.warning("reaped %s job(s) orphaned by a previous restart", reaped)

    log.info("ingest ready; storage root %s", config.storage_root)
    yield

    executor.shutdown(wait=False, cancel_futures=True)
    db.close_pool()


app = FastAPI(title="reconciliation-ingest", version="1.0.0", lifespan=lifespan)


def _not_found() -> JSONResponse:
    """Every authorization failure is 404, never 401.

    A 401 confirms the service exists and that the caller found a real endpoint,
    which is information worth having if you are probing shared-network. The
    same 404 for "wrong token", "no token" and "no such job" carries nothing.
    """
    return JSONResponse({"detail": "Not found"}, status_code=404)


def authorized(token: str | None) -> bool:
    if config is None or not token:
        return False
    # Constant time: a byte-by-byte comparison leaks the token's prefix to
    # anyone willing to measure.
    return hmac.compare_digest(token, config.ingest_token)


# ── models ─────────────────────────────────────────────────────────────────


class ParseRequest(BaseModel):
    batch_id: str
    stored_path: str
    sheet_name: str | None = None
    header_row: int = Field(default=1, ge=1, le=100)
    sample_rows: int = Field(default=8, ge=1, le=200)
    requested_by: str | None = None


class LeadsRequest(BaseModel):
    batch_id: str
    stored_path: str
    requested_by: str | None = None


class ProofRequest(BaseModel):
    stored_path: str
    original_name: str | None = None


# ── routes ─────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, Any]:
    """Unauthenticated on purpose: the container healthcheck calls it, and it
    reveals nothing beyond whether the database answers."""
    try:
        with db.connection() as conn, conn.cursor() as cur:
            cur.execute("select 1")
            cur.fetchone()
        return {"status": "ok", "database": "up"}
    except Exception:  # noqa: BLE001
        log.exception("health probe failed")
        return JSONResponse({"status": "degraded", "database": "down"}, status_code=503)


def _job_for(kind: str, batch_id: str, requested_by: str | None) -> str | None:
    """Creates the job row, or None if `batch_id` does not name a real batch.

    Both checks exist for the reason spelled out on `job_status`: every failure
    this service returns must look the same from outside, and an exception path
    quietly broke that on the two POST routes.

    A malformed id reaches Postgres as an invalid uuid cast and a well-formed one
    for a batch that does not exist trips the `ingest_job.batch_id` foreign key.
    Both surface as a 500 — and a 500 where a wrong token gets 404 tells an
    unauthenticated prober that their token was accepted. It also puts a psycopg
    traceback in the log for what is, from the caller's side, a typo.
    """
    if not _is_uuid(batch_id):
        return None
    try:
        return db.create_job(kind, batch_id, requested_by)
    except psycopg.errors.ForeignKeyViolation:
        return None


@app.post("/jobs/parse")
async def start_parse(
    body: ParseRequest,
    background: BackgroundTasks,
    x_ingest_token: str | None = Header(default=None),
):
    if not authorized(x_ingest_token):
        return _not_found()

    job_id = _job_for("PARSE", body.batch_id, body.requested_by)
    if job_id is None:
        return _not_found()

    background.add_task(
        executor.submit,
        jobs.run_parse,
        config, job_id, body.batch_id, body.stored_path,
        body.sheet_name, body.header_row, body.sample_rows,
    )
    return {"job_id": job_id, "status": "QUEUED"}


@app.post("/jobs/leads")
async def start_leads(
    body: LeadsRequest,
    background: BackgroundTasks,
    x_ingest_token: str | None = Header(default=None),
):
    if not authorized(x_ingest_token):
        return _not_found()

    job_id = _job_for("LEADS", body.batch_id, body.requested_by)
    if job_id is None:
        return _not_found()

    background.add_task(
        executor.submit,
        jobs.run_leads,
        config, job_id, body.batch_id, body.stored_path,
    )
    return {"job_id": job_id, "status": "QUEUED"}


@app.get("/jobs/{job_id}")
async def job_status(job_id: str, x_ingest_token: str | None = Header(default=None)):
    if not authorized(x_ingest_token):
        return _not_found()

    # Checked BEFORE the query, and this is not cosmetic. Postgres raises on a
    # malformed uuid cast, which FastAPI turns into a 500 — and a 500 where a
    # wrong token gets 404 tells an unauthenticated prober that their token was
    # accepted. The whole point of `_not_found` is that every failure looks the
    # same from outside, and an exception path quietly broke that.
    #
    # `_job_for` makes the same check on the two POST routes. It was missing
    # there until a malformed `batch_id` produced exactly this 500, with a
    # psycopg traceback in the log, on a route that had the reasoning written
    # down two functions away.
    if not _is_uuid(job_id):
        return _not_found()

    row = db.get_job(job_id)
    if row is None:
        return _not_found()

    return {
        "job_id": str(row["id"]),
        "kind": row["kind"],
        "status": row["status"],
        "stage": row["stage"],
        "done": row["done"],
        "total": row["total"],
        "result": row["result"],
        "error": row["error"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


@app.post("/proofs/inspect")
async def inspect_proof(body: ProofRequest, x_ingest_token: str | None = Header(default=None)):
    """Synchronous: a proof is one file and inspection is milliseconds.

    Returns what the document IS, never a judgement about whether it supports
    the correction. That decision is the verifier's, and a gate whose verifier
    is a regex is not a gate.
    """
    if not authorized(x_ingest_token):
        return _not_found()

    try:
        path = jobs.safe_path(config, body.stored_path)  # type: ignore[arg-type]
    except (ValueError, FileNotFoundError):
        return _not_found()

    extension = Path(body.original_name or body.stored_path).suffix
    summary = inspect(path, extension)

    return {
        "kind": summary.kind,
        "declared_kind": summary.declared_kind,
        "magic_ok": summary.magic_ok,
        "size_bytes": summary.size_bytes,
        "pages": summary.pages,
        "looks_scanned": summary.looks_scanned,
        "text_excerpt": summary.text_excerpt,
        "references": summary.references,
        "warnings": summary.warnings,
    }


@app.exception_handler(ConfigError)
async def config_error_handler(_: Request, exc: ConfigError):
    return JSONResponse({"detail": str(exc)}, status_code=500)
