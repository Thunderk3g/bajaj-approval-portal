"""Lead Dump -> attributed leads.

The sheet carries 15 real columns across ~54,507 rows. `SM_CODE` is the
attribution key and belongs to the same identifier family as
`sales_record.sm_id` — `ICCS427343` and `C2CM24850` against the master's
`ICCSP90766` and `C2CM21350` — so a lead attributes to a rep directly.

Leads deliberately do NOT join to `sales_record`. `Lead Dump` has no `Apps_No`,
so there is no key to join on, and inventing a synthetic link would be a claim
the data does not support. A lead is a parallel, read-only view scoped by
SM_CODE: a rep sees their own, and that is all it is for.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, fields
from datetime import date
from typing import Any

from .workbook import excel_serial_to_date

#: Column headers as they appear in the sheet, mapped to our field names.
#: `Location` appears twice, so build_columns() suffixes them and the second is
#: reachable as "Location (2)" — kept because the two are not always equal.
COLUMN_MAP: dict[str, str] = {
    "LEAD_NO": "lead_no",
    "PROD_ID": "prod_id",
    "Product Mix": "product_mix",
    "TL_NAME": "tl_name",
    "Location (1)": "location",
    "Location (2)": "location_alt",
    "Location": "location",
    "Saving Yes/No": "saving_flag",
    "Register Date": "register_date",
    "Product type": "product_type",
    "Source": "source",
    "SM Name": "sm_name",
    "SM_CODE": "sm_code",
    "CCM": "ccm_name",
    "CCM Code": "ccm_code",
    "Source For Jun Target": "source_target",
}

#: The sentinel set the source workbook uses for "no value". Identical to the
#: Node importer's: 86% of `Source` and 100% of several other columns are a
#: literal hyphen, and treating that as data makes every gap metric useless.
SENTINELS = {"-", "na", "n/a", "null", "#n/a", "nil", "none", ""}

#: Real codes are alphanumeric, but hyphens occur — see UNASSIGNED_SM_CODE. A
#: rule that rejected them would silently discard every lead carrying one.
_SM_CODE = re.compile(r"^[A-Z0-9][A-Z0-9\-]{2,31}$")

#: The workbook's marker for a lead that has not been given to anyone.
#:
#: Measured at 544 of the first 20,000 rows (2.72%), and it is the ONLY value in
#: that sample that is not a real rep code. It is a lead like any other — it just
#: has no owner yet — so it is stored and surfaced as an "unassigned" pool rather
#: than dropped. Treating it as bad data would hide 2.7% of the pipeline from
#: the people whose job is to work it.
UNASSIGNED_SM_CODE = "111222-UN"


def is_unassigned(sm_code: str | None) -> bool:
    """True when a lead has no owning rep.

    A separate predicate rather than a magic string at each call site, because
    three places ask this question — the rep's scoped query, the admin's
    unassigned list, and the attribution counter — and a typo in any of them
    would silently reclassify leads.
    """
    return sm_code is None or sm_code.upper() == UNASSIGNED_SM_CODE


def normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    if text.lower() in SENTINELS:
        return None
    return text or None


def normalize_identifier(value: Any) -> str | None:
    """Numeric identifiers arrive as floats and must not become '1.05683457e+08'.

    LEAD_NO reads as 105683457.0. Rendering that through str() gives a decimal
    tail; through a float format it can give scientific notation. Neither is the
    lead number anybody quotes, so integral floats are converted via int().
    """
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return normalize_text(value)


def normalize_sm_code(value: Any) -> str | None:
    """Uppercased, because the source is inconsistent about case.

    Six reps in the June data appear in both cases. Without this each would see
    a partial view of their own leads, with the rest invisible — the same defect
    the master importer already guards against for `SM_ID`.
    """
    text = normalize_identifier(value)
    if text is None:
        return None
    code = text.upper()
    return code if _SM_CODE.match(code) else None


@dataclass
class Lead:
    lead_no: str
    sm_code: str | None = None
    sm_name: str | None = None
    tl_name: str | None = None
    ccm_name: str | None = None
    ccm_code: str | None = None
    location: str | None = None
    location_alt: str | None = None
    register_date: date | None = None
    source: str | None = None
    product_type: str | None = None
    product_mix: str | None = None
    prod_id: str | None = None
    saving_flag: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


#: Field names Lead actually carries. COLUMN_MAP is allowed to name a target
#: with no column behind it; this is what stops such a target being dropped
#: silently instead of landing in extra.
_LEAD_FIELDS = {f.name for f in fields(Lead)}


@dataclass
class LeadOutcome:
    total_rows: int = 0
    parsed: int = 0
    #: Rows with no usable LEAD_NO. Counted and reported, never silently dropped.
    skipped_no_lead_no: int = 0
    #: Leads carrying the UNASSIGNED_SM_CODE sentinel, or no code at all. Stored
    #: and counted, never dropped: these are real leads waiting to be given to
    #: someone, and they are exactly what an admin needs to see.
    unassigned: int = 0
    #: SM_CODEs present in the data but absent from the Manpower roster.
    orphan_sm_codes: set[str] = field(default_factory=set)
    #: Rows whose LEAD_NO had already appeared earlier in the same sheet.
    #:
    #: The sheet genuinely repeats lead numbers, and the last occurrence wins —
    #: file order is chronological, so a later row is the more recent statement
    #: about that lead. Counted rather than assumed away because the count is the
    #: difference between "54,507 rows produced 54,372 leads" being explained and
    #: looking like 135 rows went missing.
    duplicates: int = 0


def row_to_lead(row: dict[str, Any]) -> Lead | None:
    """Maps one streamed row onto a Lead, or None when it has no identity.

    A row without a LEAD_NO cannot be stored idempotently — a re-import would
    insert it again every time — so it is refused here and counted by the caller
    rather than given a synthetic key.
    """
    mapped: dict[str, Any] = {}
    extra: dict[str, Any] = {}

    for header, value in row.items():
        target = COLUMN_MAP.get(header)
        # A target COLUMN_MAP names but Lead has no field for would otherwise
        # vanish: it is not unmapped, so it never reaches extra, and it is not a
        # Lead field, so nothing ever reads it back out. `Source For Jun Target`
        # was lost exactly this way. Falling through to extra keeps the column
        # retained, which is what the spec asks of every non-attribution field.
        if target is None or target not in _LEAD_FIELDS:
            text = normalize_text(value)
            if text is not None:
                extra[header] = text
            continue
        mapped[target] = value

    lead_no = normalize_identifier(mapped.get("lead_no"))
    if not lead_no:
        return None

    return Lead(
        lead_no=lead_no,
        sm_code=normalize_sm_code(mapped.get("sm_code")),
        sm_name=normalize_text(mapped.get("sm_name")),
        tl_name=normalize_text(mapped.get("tl_name")),
        ccm_name=normalize_text(mapped.get("ccm_name")),
        ccm_code=normalize_identifier(mapped.get("ccm_code")),
        location=normalize_text(mapped.get("location")),
        location_alt=normalize_text(mapped.get("location_alt")),
        register_date=excel_serial_to_date(mapped.get("register_date")),
        source=normalize_text(mapped.get("source")),
        product_type=normalize_text(mapped.get("product_type")),
        product_mix=normalize_text(mapped.get("product_mix")),
        prod_id=normalize_identifier(mapped.get("prod_id")),
        saving_flag=normalize_text(mapped.get("saving_flag")),
        extra=extra,
    )
