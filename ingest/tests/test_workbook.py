"""Reader tests.

Run against the real workbook when it is present, because the properties under
test are properties OF that file — the rogue 16,383-column row, the duplicated
`Location` header, the sentinel hyphens. A synthetic fixture that omitted any of
them would pass while the real import failed.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import pytest

from app.leads import (
    UNASSIGNED_SM_CODE,
    LeadOutcome,
    is_unassigned,
    normalize_identifier,
    normalize_sm_code,
    normalize_text,
    row_to_lead,
)
from app.workbook import (
    _contiguous_width,
    build_columns,
    excel_serial_to_date,
    list_sheets,
    read_sheet,
    resolve_sheet,
    stream_leads,
    trim_trailing_blanks,
)

WORKBOOK = Path(
    os.environ.get(
        "TEST_WORKBOOK",
        r"C:\Users\Diwakar.Adhikari01\Desktop\Businesses Dashboard Jun'26.xlsb",
    )
)

needs_workbook = pytest.mark.skipif(
    not WORKBOOK.exists(), reason=f"source workbook not present at {WORKBOOK}"
)


# ── pure helpers ───────────────────────────────────────────────────────────


def test_trim_trailing_blanks_drops_only_the_tail():
    assert trim_trailing_blanks([1, None, 2, None, None]) == [1, None, 2]
    assert trim_trailing_blanks([None, None]) == []
    assert trim_trailing_blanks([]) == []
    # A blank in the MIDDLE is data — an empty cell between two populated ones
    # means "no value here", not "the row ended".
    assert trim_trailing_blanks(["a", "", "b"]) == ["a", "", "b"]


def test_build_columns_disambiguates_the_duplicated_location_header():
    # Lead Dump really does carry two columns both titled Location. Without a
    # suffix the second silently overwrites the first in the row dict.
    cols = build_columns(["LEAD_NO", "Location", "Location", "SM_CODE"])
    assert cols == ["LEAD_NO", "Location (1)", "Location (2)", "SM_CODE"]


def test_build_columns_keeps_blank_headers_addressable():
    assert build_columns(["A", None, "B"]) == ["A", "(column 2)", "B"]


def test_build_columns_ignores_the_rogue_trailing_run():
    # The one row declaring 16,383 columns is all trailing blanks past 15.
    assert build_columns(["A", "B"] + [None] * 16_000) == ["A", "B"]


def test_excel_serial_dates_match_the_node_importer():
    # 46174 is Register Date's observed value; the June 2026 window.
    assert excel_serial_to_date(46174) == date(2026, 6, 1)
    assert excel_serial_to_date(None) is None
    # An identifier that landed in a date column must not become a date.
    assert excel_serial_to_date(105683457) is None


def test_sm_code_is_uppercased():
    # Six reps appear in both cases; without this each sees half their book.
    assert normalize_sm_code("c2cm24850") == "C2CM24850"
    assert normalize_sm_code("ICCS427343") == "ICCS427343"
    assert normalize_sm_code("-") is None
    assert normalize_sm_code(None) is None


def test_identifiers_never_render_in_scientific_notation():
    # LEAD_NO arrives as 105683457.0 and must not become 1.05683457e+08.
    assert normalize_identifier(105683457.0) == "105683457"
    assert "e+" not in (normalize_identifier(5920000001.0) or "")


def test_sentinels_become_none():
    for sentinel in ("-", "N/A", "n/a", "NULL", "#N/A", "  "):
        assert normalize_text(sentinel) is None
    assert normalize_text("  Noida  ") == "Noida"


def test_row_without_lead_no_is_refused_not_synthesised():
    # A synthetic key would re-insert the row on every import.
    assert row_to_lead({"SM_CODE": "C2CM24850"}) is None


def test_row_to_lead_maps_the_attribution_columns():
    lead = row_to_lead(
        {
            "LEAD_NO": 105683457.0,
            "SM_CODE": "iccs427343",
            "SM Name": "Shikha Singh",
            "TL_NAME": "Adarsh - CSR",
            "Location (1)": "Noida",
            "Register Date": 46174.0,
            "Source": "BFL",
            "Unmapped Column": "kept",
        }
    )
    assert lead is not None
    assert lead.lead_no == "105683457"
    assert lead.sm_code == "ICCS427343"
    assert lead.sm_name == "Shikha Singh"
    assert lead.location == "Noida"
    assert lead.register_date == date(2026, 6, 1)
    # Anything the map does not name is preserved rather than dropped.
    assert lead.extra["Unmapped Column"] == "kept"


def test_both_location_columns_are_kept_apart():
    # The sheet carries two columns both titled Location. They are equal in the
    # June data but the schema holds each, and collapsing them would make a
    # future divergence unrecoverable.
    lead = row_to_lead(
        {"LEAD_NO": 1.0, "Location (1)": "Noida", "Location (2)": "Delhi NCR"}
    )
    assert lead.location == "Noida"
    assert lead.location_alt == "Delhi NCR"


def test_a_mapped_target_with_no_lead_field_is_retained_in_extra():
    # COLUMN_MAP names `Source For Jun Target`, but Lead has no such field and
    # neither does the table. Before this it reached neither mapped output nor
    # extra, so the column was read and then silently thrown away.
    lead = row_to_lead({"LEAD_NO": 1.0, "Source For Jun Target": "BFL"})
    assert lead.extra["Source For Jun Target"] == "BFL"


# ── against the real workbook ──────────────────────────────────────────────


@needs_workbook
def test_lists_every_sheet_without_reading_them():
    sheets = list_sheets(WORKBOOK)
    names = {s.name.strip().lower() for s in sheets}
    assert "login data" in names
    assert "lead dump" in names
    assert len(sheets) == 10
    # Row counts are deliberately not reported: the only number available
    # without reading is the declared range, which for Lead Dump is a lie.
    assert all(s.rows is None for s in sheets)


@needs_workbook
def test_reads_the_transaction_sheet():
    sheets = [s.name for s in list_sheets(WORKBOOK)]
    chosen = resolve_sheet(sheets, None)
    assert chosen.strip().lower() == "login data"

    parsed = read_sheet(WORKBOOK, chosen, header_row=1, max_rows=10)
    assert "Apps_No" in parsed.columns
    assert "SM_ID" in parsed.columns
    assert len(parsed.rows) == 10
    assert parsed.total_rows > 1000


@needs_workbook
def test_read_sheet_refuses_lead_dump_rather_than_allocating_28gb():
    # The refusal is the point. Discovering this at runtime means a dead worker.
    with pytest.raises(ValueError, match="stream_leads"):
        read_sheet(WORKBOOK, "Lead Dump")


def test_contiguous_width_stops_at_the_first_gap():
    # Lead Dump's header trims to 16,383 cells: the real 15-column table, then
    # thousands of empties, then two stray labels. The table is the run before
    # the first gap; the strays are spreadsheet debris.
    header = ["A", "B", "C"] + [None] * 5000 + ["Product type", "Source"]
    assert _contiguous_width(header) == 3
    # A well-formed header has no gap and is unaffected.
    assert _contiguous_width(["A", "B", "C"]) == 3


def test_strays_past_the_gap_must_not_rename_the_real_columns():
    # The two strays at columns 16,381-2 read "Product type" and "Source" — the
    # same labels as the real columns. Narrow to the contiguous width BEFORE
    # naming and they are simply gone.
    header = ["LEAD_NO", "Product type", "Source"] + [None] * 5000 + ["Product type", "Source"]
    width = _contiguous_width(header)
    assert build_columns(header[:width]) == ["LEAD_NO", "Product type", "Source"]

    # Naming first and truncating after is the defect this guards: each real
    # column looks duplicated, comes back suffixed, and COLUMN_MAP then misses
    # it — which left every lead with a null source and product_type.
    assert build_columns(header)[:width] == ["LEAD_NO", "Product type (1)", "Source (1)"]


@needs_workbook
def test_streams_lead_dump_at_its_real_width():
    rows = []
    for i, row in enumerate(stream_leads(WORKBOOK)):
        rows.append(row)
        if i >= 999:
            break

    assert len(rows) == 1000
    # EVERY row is bounded to the real table width, including the one row that
    # itself carries 16,383 cells. Before _contiguous_width that row produced a
    # dict of 16,383 keys, nearly all of them empty "(column N)" entries headed
    # straight for the extra jsonb.
    assert {len(r) for r in rows} == {15}
    assert "SM_CODE" in rows[0]
    assert "LEAD_NO" in rows[0]
    # Both Location columns survive under distinct keys.
    assert "Location (1)" in rows[0] and "Location (2)" in rows[0]
    # And the two real columns the strays share a name with keep their own
    # names, so COLUMN_MAP still reaches them.
    assert "Product type" in rows[0] and "Source" in rows[0]


@needs_workbook
def test_real_leads_carry_source_and_product_type():
    # These read as null for every one of the 54,507 leads while the strays at
    # columns 16,381-2 were renaming their columns.
    row = next(iter(stream_leads(WORKBOOK)))
    lead = row_to_lead(row)
    assert lead.source is not None
    assert lead.product_type is not None


@needs_workbook
def test_leads_attribute_to_a_rep_or_to_the_unassigned_pool():
    outcome = LeadOutcome()
    seen_codes: set[str] = set()

    for i, row in enumerate(stream_leads(WORKBOOK)):
        lead = row_to_lead(row)
        outcome.total_rows += 1
        if lead is None:
            outcome.skipped_no_lead_no += 1
        elif is_unassigned(lead.sm_code):
            outcome.unassigned += 1
        else:
            seen_codes.add(lead.sm_code)
        if i >= 4999:
            break

    # Every row resolves to exactly one of: a real rep, or the unassigned pool.
    # Nothing is dropped, and nothing is lost to a normalisation rule.
    assert outcome.skipped_no_lead_no == 0
    assert outcome.total_rows == 5000
    assert outcome.unassigned > 0, "expected some 111222-UN leads in this sample"
    assert len(seen_codes) > 10
    assert all(c == c.upper() for c in seen_codes)
    assert UNASSIGNED_SM_CODE not in seen_codes


def test_unassigned_sentinel_survives_normalisation():
    # The hyphen must not cause the code to be rejected: 2.72% of leads carry
    # it, and rejecting it silently hid every one of them.
    assert normalize_sm_code("111222-UN") == UNASSIGNED_SM_CODE
    assert is_unassigned("111222-un") is True
    assert is_unassigned(None) is True
    assert is_unassigned("C2CM24850") is False


@needs_workbook
def test_raw_reader_matches_public_api():
    """The private-internals reader must agree with pyxlsb's own `rows()`.

    `_iter_raw_rows` reaches into `_reader`, `_data_offset` and `_stringtable`
    to avoid allocating one Cell per DECLARED column per row — the difference
    between 41 rows/second and a usable import. That is a real risk to take, and
    this is the mitigation: if a pyxlsb upgrade moves those internals or changes
    the record semantics, this fails loudly instead of the service quietly
    producing wrong leads.
    """
    from pyxlsb import open_workbook

    from app.workbook import _iter_raw_rows, trim_trailing_blanks

    with open_workbook(str(WORKBOOK)) as wb:
        with wb.get_sheet("Lead Dump") as sheet:
            official = []
            for row in sheet.rows(sparse=True):
                if not row:
                    continue
                official.append((row[0].r, trim_trailing_blanks([c.v for c in row])))
                if len(official) >= 200:
                    break

    with open_workbook(str(WORKBOOK)) as wb:
        with wb.get_sheet("Lead Dump") as sheet:
            ours = []
            for index, cells in _iter_raw_rows(sheet, None):
                ours.append((index, trim_trailing_blanks(cells)))
                if len(ours) >= 200:
                    break

    assert len(ours) == len(official)
    for (i_ours, c_ours), (i_off, c_off) in zip(ours, official):
        assert i_ours == i_off
        assert c_ours == c_off


@needs_workbook
def test_narrow_width_drops_only_debris_past_the_table():
    """Reading at the real width must lose no DATA, only the rogue row's tail."""
    from pyxlsb import open_workbook

    from app.workbook import _contiguous_width, _iter_raw_rows, trim_trailing_blanks

    with open_workbook(str(WORKBOOK)) as wb:
        with wb.get_sheet("Lead Dump") as sheet:
            wide = [cells for _, cells in _iter_raw_rows(sheet, None)][:300]

    width = _contiguous_width(wide[0])

    with open_workbook(str(WORKBOOK)) as wb:
        with wb.get_sheet("Lead Dump") as sheet:
            narrow = [cells for _, cells in _iter_raw_rows(sheet, width)][:300]

    # The header's tail carries four strays, all past the real 15-column table:
    # '-' and 'N/A' at indices 21-22 (both sentinel values, which normalise to
    # None anyway) and the two labels at 16,381-2. None of them heads a column
    # with data — that is what makes them debris rather than a narrower read
    # losing something.
    HEADER_DEBRIS = {"-", "N/A", "Product type", "Source"}

    # Exactly ONE body row also has content out there: 'Term' and 'Organic
    # Leads' at columns 16,381-2, under those stray "Product type" / "Source"
    # labels. It is a stray paste, and dropping it is the right call — the same
    # row carries its real Product type and Source in columns 8 and 9, and
    # keeping the strays is precisely what produced the duplicate-suffixed
    # column names that nulled `source` and `product_type` on all 54,507 leads.
    #
    # It is asserted rather than waved away because it IS a deliberate discard
    # of two cells, and a future file where the tail carries something else
    # should fail here and be looked at rather than pass silently.
    STRAY_BODY_VALUES = {"Term", "Organic Leads"}
    rows_losing_content = 0

    for position, (w_row, n_row) in enumerate(zip(wide, narrow)):
        # Everything inside the table is identical, on every row.
        assert trim_trailing_blanks(w_row[:width]) == trim_trailing_blanks(n_row)

        dropped = [v for v in w_row[width:] if v is not None and str(v).strip()]
        if not dropped:
            continue

        if position == 0:
            assert set(dropped) <= HEADER_DEBRIS
        else:
            rows_losing_content += 1
            assert set(dropped) <= STRAY_BODY_VALUES

    assert rows_losing_content <= 1
