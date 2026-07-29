"""The background workers.

Each runs in a thread and reports progress to `ingest_job`. They are written to
be interruptible-safe rather than resumable: a job killed halfway leaves nothing
half-written, because every write path either commits a whole chunk or none of
it, and the batch is only marked usable at the very end.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import db
from .config import Config
from .leads import (
    UNASSIGNED_SM_CODE,
    LeadOutcome,
    is_unassigned,
    row_to_lead,
)
from .workbook import list_sheets, read_sheet, resolve_sheet, stream_leads

log = logging.getLogger("ingest.jobs")

#: Leads written per transaction. Large enough that 54,507 rows is ~55 round
#: trips, small enough that a failure loses a second of work rather than all of it.
LEAD_CHUNK = 1000


def safe_path(config: Config, stored_path: str) -> Path:
    """Resolves a stored path against the storage root, refusing escapes.

    Mirrors resolveStoredPath() on the Node side. The path arrives from the
    database rather than from a user, but it crosses a service boundary to get
    here, and a boundary is exactly where "it came from a trusted caller" stops
    being verifiable.
    """
    # The Node side writes Windows-style separators; normalise before resolving.
    candidate = (config.storage_root / stored_path.replace("\\", "/")).resolve()
    root = config.storage_root.resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("Stored path escapes the storage root")
    if not candidate.is_file():
        raise FileNotFoundError(f"No stored file at {stored_path}")
    return candidate


# ── parse: sheets + a sample of the transaction sheet ──────────────────────


def run_parse(config: Config, job_id: str, batch_id: str, stored_path: str,
              sheet_name: str | None, header_row: int, sample_rows: int) -> None:
    """What the review page needs: sheet names, columns, and a few real rows.

    This is the work that took 74.6 s in Node. It runs here in well under a
    second, but it still runs as a JOB rather than inline, because the commit
    that follows it is genuinely long and the UI needs one progress model, not
    two.
    """
    try:
        db.start_job(job_id, "opening workbook")
        path = safe_path(config, stored_path)

        db.update_progress(job_id, "listing sheets", 0, 3)
        sheets = list_sheets(path)
        names = [s.name for s in sheets]

        chosen = resolve_sheet(names, sheet_name)
        if chosen is None:
            raise ValueError("This workbook has no sheet that could hold transaction rows.")

        db.update_progress(job_id, f"reading {chosen}", 1, 3)
        parsed = read_sheet(path, chosen, header_row=header_row, max_rows=sample_rows)

        db.update_progress(job_id, "recording", 2, 3)
        result: dict[str, Any] = {
            "sheets": [{"name": n} for n in names],
            "chosen_sheet": chosen,
            "header_row": header_row,
            "columns": parsed.columns,
            "sample_rows": parsed.rows,
            "total_rows": parsed.total_rows,
            "has_lead_dump": any(n.strip().lower() == "lead dump" for n in names),
        }
        db.finish_job(job_id, result)
        log.info("parse job %s finished: %s columns, %s rows", job_id, len(parsed.columns), parsed.total_rows)

    except Exception as exc:  # noqa: BLE001 — the message is the product here
        log.exception("parse job %s failed", job_id)
        db.fail_job(job_id, str(exc))


# ── leads: stream Lead Dump and attribute to reps ──────────────────────────


def run_leads(config: Config, job_id: str, batch_id: str, stored_path: str) -> None:
    """Streams `Lead Dump` and writes attributed leads.

    Never holds more than LEAD_CHUNK rows. The sheet's declared range is 893
    million cells and materialising it asks for ~28 GB; streaming reads it in
    constant memory at its real 15-column width.
    """
    outcome = LeadOutcome()
    seen_codes: set[str] = set()

    # Bounded by the number of DISTINCT leads, not by rows — about 54,000 short
    # strings for the real sheet, a few megabytes. That is a deliberate exception
    # to this reader's "never materialise" rule, and it buys an accurate
    # duplicate count: `collapse_duplicate_lead_nos` can only see collisions
    # inside one 1,000-row chunk, so counting there would under-report a repeat
    # that straddles a chunk boundary. A number that quietly undercounts is worse
    # than no number.
    seen_lead_nos: set[str] = set()

    try:
        db.start_job(job_id, "opening workbook")
        path = safe_path(config, stored_path)
        period_id = db.batch_period_id(batch_id) or db.current_period_id()

        db.update_progress(job_id, "streaming Lead Dump", 0, None)

        buffer: list[tuple] = []
        written = 0

        with db.connection() as conn:
            for row in stream_leads(path):
                outcome.total_rows += 1
                lead = row_to_lead(row)

                if lead is None:
                    outcome.skipped_no_lead_no += 1
                    continue

                if lead.lead_no in seen_lead_nos:
                    outcome.duplicates += 1
                else:
                    seen_lead_nos.add(lead.lead_no)

                unassigned = is_unassigned(lead.sm_code)
                if unassigned:
                    outcome.unassigned += 1
                else:
                    seen_codes.add(lead.sm_code)  # type: ignore[arg-type]

                outcome.parsed += 1
                buffer.append(
                    (
                        lead.lead_no, lead.sm_code, lead.sm_name, lead.tl_name,
                        lead.ccm_name, lead.ccm_code, lead.location, lead.location_alt,
                        lead.register_date, lead.source, lead.product_type,
                        lead.product_mix, lead.prod_id, lead.saving_flag,
                        unassigned, json.dumps(lead.extra, default=str),
                        batch_id, period_id,
                    )
                )

                if len(buffer) >= LEAD_CHUNK:
                    written += db.upsert_leads(buffer, conn)
                    conn.commit()
                    buffer.clear()
                    db.update_progress(job_id, "streaming Lead Dump", written, None)

            if buffer:
                written += db.upsert_leads(buffer, conn)
                conn.commit()

        db.update_progress(job_id, "flagging orphan codes", written, written)

        # A code owning real leads but absent from the roster is flagged, not
        # dropped: the leads are real and the rep is real, the roster sheet is
        # merely stale.
        known = db.known_sm_codes(seen_codes)
        outcome.orphan_sm_codes = seen_codes - known

        db.finish_job(
            job_id,
            {
                "total_rows": outcome.total_rows,
                "written": written,
                "attributed": outcome.parsed - outcome.unassigned,
                "unassigned": outcome.unassigned,
                "unassigned_code": UNASSIGNED_SM_CODE,
                "skipped_no_lead_no": outcome.skipped_no_lead_no,
                # Rows, not leads. `written` counts statements sent, so a lead
                # repeated across two chunks is counted twice there and once
                # here; the two numbers answer different questions and neither
                # is the row count.
                "duplicate_lead_nos": outcome.duplicates,
                "distinct_sm_codes": len(seen_codes),
                "orphan_sm_codes": sorted(outcome.orphan_sm_codes)[:100],
                "orphan_count": len(outcome.orphan_sm_codes),
            },
        )
        log.info(
            "leads job %s finished: %s written, %s unassigned, %s orphan codes",
            job_id, written, outcome.unassigned, len(outcome.orphan_sm_codes),
        )

    except Exception as exc:  # noqa: BLE001
        log.exception("leads job %s failed", job_id)
        db.fail_job(job_id, str(exc))
