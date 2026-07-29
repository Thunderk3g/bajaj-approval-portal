"""Workbook reading.

Two readers, deliberately, because the source workbook contains two genuinely
different problems.

`calamine` opens an .xlsb container lazily and is the right tool for every sheet
whose declared range matches its data: 0.00s to list all ten sheet names and
0.33s to read `Login Data` (1,172 x 36), against roughly 37s per pass for SheetJS
in Node.

`Lead Dump` is the exception and cannot go through calamine at all. Its DECLARED
range is 54,508 x 16,383 — about 893 million cells — because exactly ONE row
carries formatting out to column 16,383. Every other populated row is 15 columns
wide. calamine's to_python() materialises the declared range and asks for ~28 GB.
pyxlsb yields row by row, so the sheet is read at its real width and the rogue
row costs one trimmed list rather than the process.

The rule both readers obey: never materialise a declared range. Stream, trim
trailing blanks per row, and let the data state its own width.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator

from python_calamine import CalamineWorkbook
from pyxlsb import open_workbook as open_xlsb

#: Sheets that are presentation, not data. Named so `suggest_sheet` does not
#: offer a pivot table as the transaction sheet.
NON_DATA_SHEETS = {
    "jan target",
    "bfl & bau",
    "overall dashboard",
    "dash",
    "sm summary",
}

TRANSACTION_SHEET = "login data"
LEAD_SHEET = "lead dump"


@dataclass
class SheetInfo:
    name: str
    #: None when the reader declines to state a count. A declared range is not a
    #: row count and this must never pretend otherwise.
    rows: int | None = None


@dataclass
class ParsedSheet:
    sheet_name: str
    header_row: int
    columns: list[str] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    total_rows: int = 0


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def trim_trailing_blanks(cells: list[Any]) -> list[Any]:
    """Drops trailing empty cells, which is what makes the rogue row harmless.

    Returns a new list; the input is left alone so a caller streaming rows can
    keep its own buffer.
    """
    end = len(cells)
    while end > 0 and _blank(cells[end - 1]):
        end -= 1
    return cells[:end]


def _contiguous_width(header_cells: list[Any]) -> int:
    """How wide the table really is: the run of populated headers before the
    first gap.

    `Lead Dump`'s header row trims to 16,383 cells because two stray labels sit
    at the far right, thousands of empty columns past the real table. The
    populated run stops at 15, which is the actual table, and everything beyond
    the first gap is spreadsheet debris.

    Falls back to the full trimmed length when there is no gap, so a well-formed
    sheet is unaffected.
    """
    trimmed = trim_trailing_blanks(header_cells)
    for index, cell in enumerate(trimmed):
        if _blank(cell):
            return index
    return len(trimmed)


def build_columns(header_cells: list[Any]) -> list[str]:
    """Names the columns from a header row that is, in the real file, malformed.

    `Lead Dump` has two columns both titled `Location`. A duplicate is suffixed
    with its occurrence so the second cannot silently overwrite the first in the
    staged row dict — the same disambiguation the Node importer applies, kept
    identical so a column maps to the same key on either path.

    A blank header becomes `(column N)` so its data stays addressable rather than
    being dropped.
    """
    headers = ["" if _blank(c) else str(c).strip() for c in trim_trailing_blanks(header_cells)]

    totals: dict[str, int] = {}
    for h in headers:
        if h:
            totals[h] = totals.get(h, 0) + 1

    seen: dict[str, int] = {}
    out: list[str] = []
    for index, h in enumerate(headers):
        if not h:
            out.append(f"(column {index + 1})")
            continue
        if totals[h] > 1:
            seen[h] = seen.get(h, 0) + 1
            out.append(f"{h} ({seen[h]})")
        else:
            out.append(h)
    return out


# ── Excel serial dates ─────────────────────────────────────────────────────

#: Excel's day 0 under the 1900 system, offset for its deliberate 1900 leap-year
#: bug. Matches src/lib/import/dates.ts so a date imported by either path lands
#: on the same day.
_EXCEL_EPOCH = datetime(1899, 12, 30)


def excel_serial_to_date(value: Any) -> date | None:
    if isinstance(value, (datetime, date)):
        return value.date() if isinstance(value, datetime) else value
    if not isinstance(value, (int, float)):
        return None
    # Below 1 is a time-of-day fraction with no date; above 60000 is past 2064
    # and is far likelier to be an identifier that landed in a date column.
    if value < 1 or value > 60000:
        return None
    return (_EXCEL_EPOCH + timedelta(days=float(value))).date()


# ── calamine path: everything except Lead Dump ─────────────────────────────


def list_sheets(path: Path) -> list[SheetInfo]:
    """Sheet names, without paying to parse anything.

    Measured at 0.00s on the 9.14 MB source workbook. Row counts are deliberately
    NOT reported here: the only number available without reading is the declared
    range, and for `Lead Dump` that is 54,508 against ~54,507 real rows with one
    row declaring 16,383 columns. Reporting a declared range as a row count is
    how the 28 GB allocation gets rationalised as "it really is that big".
    """
    workbook = CalamineWorkbook.from_path(str(path))
    return [SheetInfo(name=name) for name in workbook.sheet_names]


def resolve_sheet(names: list[str], wanted: str | None) -> str | None:
    if wanted:
        for name in names:
            if name.strip().lower() == wanted.strip().lower():
                return name
        return None
    for name in names:
        if name.strip().lower() == TRANSACTION_SHEET:
            return name
    for name in names:
        if name.strip().lower() not in NON_DATA_SHEETS and name.strip().lower() != LEAD_SHEET:
            return name
    return names[0] if names else None


def read_sheet(
    path: Path,
    sheet_name: str,
    header_row: int = 1,
    max_rows: int | None = None,
) -> ParsedSheet:
    """Reads one sheet through calamine.

    Refuses `Lead Dump` outright rather than letting a caller discover the 28 GB
    allocation at runtime. That sheet has its own streaming reader below, and the
    refusal is what stops the two paths being confused.
    """
    if sheet_name.strip().lower() == LEAD_SHEET:
        raise ValueError(
            f'"{sheet_name}" must be read with stream_leads(): its declared range is '
            f"54,508 x 16,383 and materialising it asks for roughly 28 GB."
        )

    workbook = CalamineWorkbook.from_path(str(path))
    grid = workbook.get_sheet_by_name(sheet_name).to_python()

    if len(grid) < header_row:
        return ParsedSheet(sheet_name=sheet_name, header_row=header_row)

    columns = build_columns(list(grid[header_row - 1]))
    body = grid[header_row:]

    rows: list[dict[str, Any]] = []
    for cells in body:
        trimmed = trim_trailing_blanks(list(cells))
        if not trimmed:
            continue
        rows.append({columns[i]: trimmed[i] for i in range(min(len(columns), len(trimmed)))})
        if max_rows is not None and len(rows) >= max_rows:
            break

    total = sum(1 for cells in body if trim_trailing_blanks(list(cells)))

    return ParsedSheet(
        sheet_name=sheet_name,
        header_row=header_row,
        columns=columns,
        rows=rows,
        total_rows=total,
    )


# ── pyxlsb path: Lead Dump only ────────────────────────────────────────────


def _iter_raw_rows(sheet, width: int | None) -> Iterator[tuple[int, list[Any]]]:
    """Yields `(zero-based row index, values)` straight from pyxlsb's records.

    This bypasses `Worksheet.rows()` deliberately, and the reason is the whole
    performance story of this reader.

    `rows()` allocates one `Cell` per column of the DECLARED width for every
    row it yields — `[Cell(...) for i in range(dimension.c + dimension.w)]` —
    and `sparse=True` does not change that. Sparse only skips rows that are
    absent between records; it never narrows a row. On `Lead Dump`, whose
    declared width is 16,384 against a real table of 15 columns, that is 893
    million Cell constructions for 54,507 rows, measured at 41 rows/second with
    no database attached at all. The same read here allocates `width` values per
    row instead.

    `width` is None for the first row only, where the real width is not yet
    known; that single row is read at the declared width, which costs one list.

    USES PRIVATE pyxlsb INTERNALS (`_reader`, `_data_offset`, `_stringtable`).
    That is a real cost and the mitigation is explicit: pyxlsb is pinned in
    requirements.txt, and `test_raw_reader_matches_public_api` asserts this
    function returns exactly what `rows()` does, so an upgrade that moves the
    internals fails a test rather than silently producing wrong leads.
    """
    import os

    from pyxlsb import biff12

    reader = sheet._reader
    reader.seek(sheet._data_offset, os.SEEK_SET)

    declared = sheet.dimension.c + sheet.dimension.w
    row_num = -1
    row: list[Any] | None = None

    def sized() -> list[Any]:
        return [None] * (declared if width is None else width)

    for item in reader:
        kind = item[0]

        if kind == biff12.ROW and item[1].r != row_num:
            if row is not None:
                yield row_num, row
            row_num = item[1].r
            row = sized()

        elif biff12.BLANK <= kind <= biff12.FORMULA_BOOLERR:
            if row is None:
                continue
            column = item[1].c
            # Past the real table: spreadsheet debris from the one rogue row.
            # Dropping it here is what keeps the allocation bounded.
            if column >= len(row):
                continue
            value = item[1].v
            if kind == biff12.STRING and sheet._stringtable is not None:
                value = sheet._stringtable[value]
            row[column] = value

        elif kind == biff12.SHEETDATA_END:
            if row is not None:
                yield row_num, row
            return

    if row is not None:
        yield row_num, row


def stream_leads(
    path: Path,
    sheet_name: str = "Lead Dump",
    header_row: int = 1,
    on_progress: Callable[[int], None] | None = None,
    progress_every: int = 2000,
) -> Iterator[dict[str, Any]]:
    """Yields Lead Dump rows one at a time, keyed by column name.

    Never holds more than one row. The 54,507-row sheet streams in constant
    memory, which is the only way this sheet can be read at all.

    Rows that trim to nothing are skipped — 5,493 of them are pure formatting.
    """
    with open_xlsb(str(path)) as workbook:
        with workbook.get_sheet(sheet_name) as sheet:
            columns: list[str] | None = None
            width = 0
            emitted = 0

            # Two passes over the records, not one. The first reads ONLY the
            # header, at the declared width, to learn how wide the real table
            # is; the second reads the body allocating exactly that width.
            #
            # Re-opening costs one seek. Doing it in a single pass would mean
            # every row before the header was known had to be full width, and on
            # this sheet the header is row 1 — so the "saving" would be nothing
            # while the code carried a mode switch through the hot loop.
            for index0, cells_raw in _iter_raw_rows(sheet, None):
                if index0 + 1 < header_row:
                    continue

                # The header IS the rogue row: it trims to 16,383 cells, because
                # two stray labels sit at columns 16,381-2 while the real table
                # is 15 wide. Trailing-blank trimming cannot help — those cells
                # genuinely hold text — so the width comes from the contiguous
                # run of populated headers and the strays are dropped.
                #
                # The narrowing MUST happen BEFORE naming, not after. Those two
                # strays read "Product type" and "Source" — the same labels as
                # the real columns at indices 8 and 9. Naming all 16,383 cells
                # makes each look duplicated, so both real columns come back
                # suffixed as "Product type (1)" and "Source (1)", COLUMN_MAP
                # misses them, and every one of the 54,507 leads lands with a
                # null source and product_type while the values sit unreachable
                # in the extra jsonb.
                header_cells = trim_trailing_blanks(cells_raw)
                width = _contiguous_width(header_cells)
                columns = build_columns(header_cells[:width])
                break

            if columns is None:
                return

            for index0, cells_raw in _iter_raw_rows(sheet, width):
                index = index0 + 1
                cells = trim_trailing_blanks(cells_raw)

                if index <= header_row:
                    continue

                if not cells:
                    continue

                yield {columns[i]: cells[i] for i in range(min(width, len(cells)))}

                emitted += 1
                if on_progress and emitted % progress_every == 0:
                    on_progress(emitted)

            if on_progress:
                on_progress(emitted)
