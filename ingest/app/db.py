"""Database access.

Raw psycopg over SQL, not an ORM, and deliberately so. Drizzle owns the schema;
this service only writes four tables. A second ORM with a second set of model
definitions would be a second thing that can disagree with the migrations, and
the disagreement would surface as a runtime write to a column that is not there.

`verify_schema()` is what makes that safe: it asserts on startup that every
column this service writes exists, and refuses to start otherwise. A service
that starts and then fails on the first upload is worse than one that never
starts.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool: ConnectionPool | None = None


def init_pool(database_url: str) -> None:
    global _pool
    # min_size=1 so the first upload does not pay connection setup; max_size is
    # small because this service does a handful of long transactions, not many
    # short ones.
    _pool = ConnectionPool(database_url, min_size=1, max_size=4, open=True)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    if _pool is None:
        raise RuntimeError("Database pool is not initialised")
    with _pool.connection() as conn:
        conn.row_factory = dict_row
        yield conn


#: table -> columns this service writes. Checked at startup against
#: information_schema so drift fails loudly instead of at the first upload.
REQUIRED_COLUMNS: dict[str, set[str]] = {
    "ingest_job": {
        "id", "kind", "status", "batch_id", "stage", "done", "total",
        "result", "error", "requested_by", "heartbeat_at",
        "created_at", "started_at", "finished_at",
    },
    "lead": {
        "id", "lead_no", "sm_code", "sm_name", "tl_name", "ccm_name", "ccm_code",
        "location", "location_alt", "register_date", "source", "product_type",
        "product_mix", "prod_id", "saving_flag", "is_unassigned", "extra",
        "source_batch_id", "period_id", "created_at", "updated_at",
    },
    "upload_batch": {"id", "status", "sheet_name", "header_row", "validation_report", "period_code"},
    "upload_batch_row": {"id", "batch_id", "row_number", "raw", "normalized", "issues", "status"},
}


class SchemaDriftError(RuntimeError):
    pass


def verify_schema() -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select table_name, column_name
              from information_schema.columns
             where table_schema = 'public'
               and table_name = any(%s)
            """,
            (list(REQUIRED_COLUMNS),),
        )
        found: dict[str, set[str]] = {}
        for row in cur.fetchall():
            found.setdefault(row["table_name"], set()).add(row["column_name"])

    problems: list[str] = []
    for table, columns in REQUIRED_COLUMNS.items():
        actual = found.get(table)
        if actual is None:
            problems.append(f"table '{table}' is missing entirely")
            continue
        missing = columns - actual
        if missing:
            problems.append(f"{table} is missing: {', '.join(sorted(missing))}")

    if problems:
        raise SchemaDriftError(
            "The database does not match what this service writes. Run the Drizzle "
            "migrations before starting it.\n  " + "\n  ".join(problems)
        )


# ── jobs ───────────────────────────────────────────────────────────────────


def create_job(kind: str, batch_id: str | None, requested_by: str | None) -> str:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            insert into ingest_job (kind, status, batch_id, requested_by, heartbeat_at)
            values (%s, 'QUEUED', %s, %s, now())
            returning id
            """,
            (kind, batch_id, requested_by),
        )
        return str(cur.fetchone()["id"])


def start_job(job_id: str, stage: str) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            update ingest_job
               set status = 'RUNNING', stage = %s, started_at = now(), heartbeat_at = now()
             where id = %s
            """,
            (stage, job_id),
        )


def update_progress(job_id: str, stage: str, done: int, total: int | None = None) -> None:
    """Also refreshes the heartbeat: progress IS liveness.

    A job that stops reporting progress is either finished or dead, and the
    reaper cannot tell them apart from a timestamp that only start_job touched.
    """
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "update ingest_job set stage = %s, done = %s, total = %s, heartbeat_at = now() where id = %s",
            (stage, done, total, job_id),
        )


def finish_job(job_id: str, result: dict[str, Any]) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            update ingest_job
               set status = 'SUCCEEDED', result = %s, finished_at = now(), heartbeat_at = now()
             where id = %s
            """,
            (json.dumps(result, default=str), job_id),
        )


def fail_job(job_id: str, message: str) -> None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            update ingest_job
               set status = 'FAILED', error = %s, finished_at = now(), heartbeat_at = now()
             where id = %s
            """,
            (message[:2000], job_id),
        )


def get_job(job_id: str) -> dict[str, Any] | None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute("select * from ingest_job where id = %s", (job_id,))
        return cur.fetchone()


def reap_stale_jobs(stale_seconds: int) -> int:
    """Marks jobs orphaned by a restart as FAILED.

    Without this a killed worker leaves a row saying RUNNING forever, and the
    admin watches a progress bar for a process that no longer exists. Runs at
    startup, which is exactly when the orphans exist.

    The message must not promise that nothing was committed. A LEADS job commits
    every LEAD_CHUNK rows, so an orphan typically HAS written tens of thousands
    of leads, and an admin told otherwise would go looking for a corruption that
    is not there. What actually makes re-running safe is that every lead write is
    an upsert keyed on lead_no, so a second run converges rather than duplicating.
    """
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            update ingest_job
               set status = 'FAILED',
                   error = 'The ingestion service stopped while this job was running. Any rows it had already committed are still there; running it again is safe and will finish the work.',
                   finished_at = now()
             where status in ('QUEUED', 'RUNNING')
               and heartbeat_at < now() - make_interval(secs => %s)
            """,
            (stale_seconds,),
        )
        return cur.rowcount


# ── leads ──────────────────────────────────────────────────────────────────

_LEAD_COLUMNS = (
    "lead_no", "sm_code", "sm_name", "tl_name", "ccm_name", "ccm_code",
    "location", "location_alt", "register_date", "source", "product_type",
    "product_mix", "prod_id", "saving_flag", "is_unassigned", "extra",
    "source_batch_id", "period_id",
)


#: Postgres caps a statement at 65,535 bind parameters. At 18 columns that is
#: 3,640 rows; 1,000 leaves headroom and keeps a failed chunk small.
MAX_ROWS_PER_STATEMENT = 1000


def collapse_duplicate_lead_nos(rows: list[tuple]) -> list[tuple]:
    """Keeps the LAST row for each lead_no, preserving order.

    Postgres refuses `ON CONFLICT DO UPDATE` when one statement proposes the
    same constrained value twice:

        ON CONFLICT DO UPDATE command cannot affect row a second time

    and the real `Lead Dump` does carry the same lead number more than once. This
    is not a theoretical edge: the first end-to-end run of this service against
    the real sheet failed on it 1.1 seconds in, having written nothing.

    It is specifically a consequence of batching. The `executemany` this replaced
    sent one statement per row, so a repeat simply updated what the earlier row
    had written and nobody had to think about it. Collapsing here restores
    exactly that behaviour — last occurrence wins — rather than picking a
    different answer for the sake of the optimisation.

    LAST rather than first, deliberately. Row order in the sheet is file order,
    so a later row is the more recent statement about that lead. Keeping the
    first would freeze a lead at a superseded owner, which is the same failure as
    `ON CONFLICT DO NOTHING` and the reason this is an upsert at all.
    """
    by_lead_no: dict[Any, tuple] = {}
    for row in rows:
        by_lead_no[row[0]] = row  # lead_no is _LEAD_COLUMNS[0]
    return list(by_lead_no.values())


def upsert_leads(rows: list[tuple], conn: psycopg.Connection) -> int:
    """Inserts or refreshes a chunk of leads, keyed on lead_no.

    Returns the number of rows actually SENT, which is the chunk size minus any
    rows collapsed by {@link collapse_duplicate_lead_nos}. The caller uses the
    difference to report duplicates rather than losing them silently.

    Upsert rather than insert: the sheet is re-uploaded monthly and carries the
    same leads again. A plain insert would collide on the unique key and abort
    the whole batch; ignoring conflicts would freeze a rep's lead at whatever the
    first import said, so a reassignment would never reach them.

    ONE multi-row VALUES statement per chunk, not `executemany`.

    This is the difference between a 42-minute job and a seconds-long one, and
    it is not a micro-optimisation. psycopg's `executemany` issues a round trip
    PER ROW, so 54,507 leads meant 54,507 round trips; measured against Postgres
    in Docker on Windows that ran at roughly 22 rows/second, and the whole job
    took 2,511 s. The reader was never the bottleneck — parsing the same sheet
    takes under a second — but a 42-minute "upload" is indistinguishable from
    the hang this service was built to remove.
    """
    if not rows:
        return 0
    if len(rows) > MAX_ROWS_PER_STATEMENT:
        raise ValueError(
            f"{len(rows)} rows exceeds {MAX_ROWS_PER_STATEMENT} per statement; "
            f"Postgres would reject the parameter count."
        )

    rows = collapse_duplicate_lead_nos(rows)

    columns = ",".join(_LEAD_COLUMNS)
    one_row = "(" + ",".join(["%s"] * len(_LEAD_COLUMNS)) + ")"
    values = ",".join([one_row] * len(rows))
    updates = ",".join(f"{c} = excluded.{c}" for c in _LEAD_COLUMNS if c != "lead_no")

    # Flattened in row order so the placeholders line up; a generator would be
    # consumed by psycopg's own length check before it reached the wire.
    flat = [value for row in rows for value in row]

    with conn.cursor() as cur:
        cur.execute(
            f"""
            insert into lead ({columns})
            values {values}
            on conflict (lead_no) do update
               set {updates}, updated_at = now()
            """,
            flat,
        )
    return len(rows)


def known_sm_codes(codes: set[str]) -> set[str]:
    """Which of these codes have a Manpower roster row.

    Used to flag orphans, exactly as the Node importer does for transaction
    data: a code seen in the data but absent from the roster still owns real
    leads, so it is flagged for an admin rather than dropped.
    """
    if not codes:
        return set()
    with connection() as conn, conn.cursor() as cur:
        cur.execute("select sm_id from manpower where sm_id = any(%s)", (list(codes),))
        return {r["sm_id"] for r in cur.fetchall()}


def current_period_id() -> str | None:
    with connection() as conn, conn.cursor() as cur:
        cur.execute("select id from period where status = 'OPEN' limit 1")
        row = cur.fetchone()
        return str(row["id"]) if row else None


def batch_period_id(batch_id: str) -> str | None:
    """The period a batch's records belong to, resolved from its period_code."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select p.id
              from upload_batch b
              join period p on p.code = b.period_code
             where b.id = %s
            """,
            (batch_id,),
        )
        row = cur.fetchone()
        return str(row["id"]) if row else None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
