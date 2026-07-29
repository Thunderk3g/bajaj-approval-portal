"""Splitting the collective workbook into single-sheet files.

The admin uploads one 9.14 MB .xlsb carrying ten sheets, and the portal takes one
workbook per batch — so a month in which only `Manpower` changed still costs a
full upload and a full parse of `Lead Dump`. This writes each sheet out as a file
of its own, which is what makes uploading one sheet possible.

It adds no reader. Every sheet comes back through app.workbook — `read_sheet` for
the nine calamine can open, `stream_leads` for `Lead Dump`, which cannot be
materialised at all — so a sheet split out here and the same sheet imported
directly have passed through identical code and cannot disagree.

Output is .xlsx, not .xlsb. `ALLOWED_EXTENSIONS` in src/lib/import/actions.ts
accepts .xlsx, and the upload action checks the first four bytes against the ZIP
signature before it stores anything, so the output has to be a real OOXML
container — which is also what rules out the cheap answer of writing CSV under an
.xlsx name.

KNOWN LIMIT, and it belongs to files this module does not own: the `Lead Dump`
output cannot be imported by the leads path today. `stream_leads` opens with
pyxlsb, which reads .xlsb only, and `read_sheet` refuses any sheet named
`Lead Dump` by NAME rather than by size — so the split file, which is a harmless
15-column table, is refused by one reader and unopenable by the other. The sheet
keeps its real name here anyway, because renaming it would be a lie about what
the file holds.
"""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from pyxlsb import open_workbook as open_xlsb

from .workbook import (
    LEAD_SHEET,
    NON_DATA_SHEETS,
    _contiguous_width,
    build_columns,
    list_sheets,
    read_sheet,
    stream_leads,
    trim_trailing_blanks,
)


@dataclass
class SheetOutcome:
    """What became of one sheet. Every sheet gets one, written or not."""

    sheet_name: str
    rows: int = 0
    columns: int = 0
    path: Path | None = None
    #: Why nothing was written. None exactly when `path` is set.
    reason: str | None = None
    #: True when `reason` is an exception rather than a decision. The CLI exits
    #: non-zero on these, so a scripted split cannot fail and look successful.
    failed: bool = False
    seconds: float = 0.0
    notes: list[str] = field(default_factory=list)


# ── names ──────────────────────────────────────────────────────────────────

#: Everything outside this is replaced. Stating the safe set rather than the
#: forbidden one because the forbidden one is long and platform-specific —
#: Windows bars <>:"/\|?* and control characters, and also trailing dots and
#: spaces — and the sheet names here already carry spaces and `&`.
_UNSAFE = re.compile(r"[^A-Za-z0-9]+")

#: Long enough to stay recognisable, short enough that the ordinal, the extension
#: and a deep output directory still fit Windows' 260-character path limit.
_MAX_SLUG = 60

#: Excel's own rules for a sheet name: these characters are refused and the name
#: is capped at 31 characters. openpyxl raises rather than truncating.
_BAD_TITLE = re.compile(r"[\[\]:*?/\\]")


def output_name(index: int, sheet_name: str) -> str:
    """A stable, Windows-safe filename for one sheet.

    The ordinal prefix is not decoration, and it does two jobs at once. It makes
    the name unique without consulting the other sheets — `Q1 Target` and
    `Q1  target` slug identically — and it keeps a sheet named `CON`, `PRN`,
    `NUL` or `COM1` from becoming a reserved device name, which Windows refuses
    to open at all and does so with an error that names neither the device nor
    the reservation.

    Same workbook in, same names out: a re-split overwrites its own output rather
    than accumulating `-1`, `-2` copies beside it.
    """
    slug = _UNSAFE.sub("-", sheet_name).strip("-").lower()[:_MAX_SLUG].strip("-")
    return f"{index:02d}-{slug or 'sheet'}.xlsx"


def sheet_title(sheet_name: str) -> str:
    """The name the sheet keeps INSIDE its own file.

    Kept as close to the original as Excel allows, because `resolve_sheet` finds
    the transaction sheet by name: a split-out `Login Data` that came back as
    `Sheet1` would no longer be recognised on re-upload, and the admin would have
    to pick it by hand every month.
    """
    return _BAD_TITLE.sub("-", sheet_name).strip()[:31] or "Sheet1"


# ── writing ────────────────────────────────────────────────────────────────

#: XML 1.0 cannot represent these code points at all, so there is nothing here to
#: preserve. openpyxl raises IllegalCharacterError on them, which would cost the
#: whole sheet over one bad cell.
_XML_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _cell(worksheet: Any, value: Any) -> Any:
    """One value, in the form openpyxl has to be told to keep.

    Numbers stay numbers. Rendering them as text is what puts `105683457.0` at
    the mercy of float formatting; written as a number the value in the XML is
    the value calamine and pyxlsb handed over, and `normalize_identifier` reads
    it back as `105683457` exactly as it does from the source .xlsb.

    One measured caveat, and it is openpyxl's, not this module's: it serialises
    a float as `%.16g`. Identifiers, counts and date serials are integral and
    round trip bit-exact, but 13 of the 56,594 rows written from this workbook
    carry a computed aggregate whose 17th significant digit is dropped —
    2484065.2399999998 becomes 2484065.24, a relative error of 2e-16. Excel
    itself only carries 15 significant digits, so no value anyone reads changes;
    it is recorded because "identical" would have been the wrong word.

    Dates stay dates, and they need no help: calamine resolves a date-formatted
    cell to a `date`, and openpyxl gives a `date` the `yyyy-mm-dd` number format
    on its own, so the round trip returns a `date`. `Lead Dump` is the exception
    and deliberately so — pyxlsb yields its `Register Date` as the serial 46174.0
    and that serial is written unchanged, because `excel_serial_to_date` is the
    convention that turns it into a date downstream. Converting it here would
    mean guessing which floats are dates, and every quantity between 1 and 60000
    — an NOP count, an FRP amount — would be guessed wrong.

    Strings are forced to type `s`. openpyxl types any string starting with `=`
    as a FORMULA: measured, a `Product Mix` of `=Term` is written as `<f>` with
    no cached result, and calamine then reads that cell as an empty string. The
    value is simply gone, and nothing in the file says so.
    """
    if isinstance(value, str):
        cell = WriteOnlyCell(worksheet, value=_XML_ILLEGAL.sub("", value))
        cell.data_type = "s"
        return cell
    return value


def _write(destination: Path, title: str, header: list[str], rows: Iterable[list[Any]]) -> int:
    """Streams one sheet to `destination`; returns the number of body rows written.

    write_only mode holds one row at a time and spools the sheet XML to a
    temporary file, which is the only reason `Lead Dump`'s 54,507 rows can be
    written here at all — an ordinary Workbook keeps every cell as a live object
    until save() and would hold the whole sheet.

    Written beside the target and renamed, because os.replace is atomic: an
    interrupted split leaves no half-written file, and a half-written .xlsx is
    the worst possible artefact — it still begins `PK\\x03\\x04`, so it passes the
    portal's signature check and fails later, in the parse job.
    """
    workbook = Workbook(write_only=True)
    worksheet = workbook.create_sheet(title)
    worksheet.append([_cell(worksheet, name) for name in header])

    written = 0
    for values in rows:
        worksheet.append([_cell(worksheet, value) for value in values])
        written += 1

    partial = destination.parent / (destination.name + ".partial")
    workbook.save(partial)
    partial.replace(destination)
    return written


# ── deciding what is a table ───────────────────────────────────────────────

#: build_columns' placeholder for a header cell that is blank. Matched rather
#: than re-derived, so a change to that format fails this module's own test
#: instead of quietly reclassifying every dashboard as a data sheet.
_UNNAMED = re.compile(r"^\(column \d+\)$")


def named_columns(columns: list[str]) -> int:
    return sum(1 for name in columns if not _UNNAMED.match(name))


def heads_a_table(columns: list[str]) -> bool:
    """Whether row 1 is a header at all.

    Two of the ten sheets are dashboards whose first row is blank or is a title:
    `Overall Dashboard` names 1 column of 16,380 and `BFL & BAU` names 1 of
    16,208. Both counts are that lopsided for the same reason `Lead Dump`'s
    header is 16,383 wide — a stray label pasted some 16,000 columns right of the
    real block, which is 34 and 20 columns wide respectively. Written out they
    would be 16,000-column files headed `(column 2)` onwards, so they are refused
    and the reason, including how many rows were left behind, is reported.

    A simple majority, not a tuned fraction. The real tables name every column
    but one — `Dash` has a spacer between its two side-by-side blocks, 17 of 18 —
    and the dashboards name almost none. Nothing measured in this workbook sits
    anywhere near the line, so a threshold would be false precision.
    """
    return bool(columns) and named_columns(columns) * 2 > len(columns)


# ── Lead Dump ──────────────────────────────────────────────────────────────


def lead_columns(source: Path, sheet_name: str) -> list[str]:
    """`Lead Dump`'s column names, read from its header row alone.

    `stream_leads` keys its rows by these names but does not hand the list out,
    and the header has to be written before the first row is streamed — so it is
    read here, one row, through pyxlsb's PUBLIC api. That one row costs 16,384
    Cell objects, because the declared width is 16,384: 0.21 s, once. It is the
    54,507 further rows at that width that make `stream_leads` reach for private
    internals, and none of that applies to a single header.

    The narrowing MUST happen before the naming. Two stray labels sit at columns
    16,381-2 reading "Product type" and "Source" — the same text as the real
    columns at indices 8 and 9 — so naming all 16,383 cells first makes both real
    columns look duplicated and they come back as "Product type (1)" and
    "Source (1)". That is the exact defect that nulled `source` and
    `product_type` on all 54,507 leads, and it would be baked into the split file
    permanently.

    `test_lead_header_matches_what_stream_leads_keys_by` holds this list and
    stream_leads' keys in step; if they ever drift, every value in the written
    file would shift a column.
    """
    with open_xlsb(str(source)) as workbook:
        with workbook.get_sheet(sheet_name) as sheet:
            for row in sheet.rows(sparse=True):
                cells = trim_trailing_blanks([cell.v for cell in row])
                return build_columns(cells[: _contiguous_width(cells)])
    return []


def _lead_rows(source: Path, sheet_name: str, columns: list[str]) -> Iterator[list[Any]]:
    """One row at a time, never more. `row.get` rather than indexing because
    stream_leads yields only as many keys as the row has populated cells."""
    for row in stream_leads(source, sheet_name):
        yield [row.get(name) for name in columns]


# ── the split ──────────────────────────────────────────────────────────────


def split_sheet(source: Path, out_dir: Path, index: int, sheet_name: str) -> SheetOutcome:
    """Writes one sheet, or explains why it did not.

    Never raises: one unreadable sheet must not cost the other nine. The failure
    is carried back in the outcome, which is the only place a caller can see it.
    """
    outcome = SheetOutcome(sheet_name=sheet_name)
    started = time.perf_counter()

    if sheet_name.strip().lower() in NON_DATA_SHEETS:
        outcome.notes.append("presentation sheet: resolve_sheet will not offer it as the transaction sheet")

    try:
        destination = out_dir / output_name(index, sheet_name)

        if sheet_name.strip().lower() == LEAD_SHEET:
            columns = lead_columns(source, sheet_name)
            if not columns:
                outcome.reason = "no header row, so its columns cannot be named"
            else:
                outcome.columns = len(columns)
                outcome.rows = _write(
                    destination,
                    sheet_title(sheet_name),
                    columns,
                    _lead_rows(source, sheet_name, columns),
                )
                outcome.path = destination
                outcome.notes.append(
                    "streamed: the declared range is 54,508 x 16,383 and was never materialised"
                )
        else:
            parsed = read_sheet(source, sheet_name)
            outcome.columns = len(parsed.columns)
            outcome.rows = parsed.total_rows

            if not parsed.columns:
                outcome.reason = "row 1 is blank, so there is nothing to head the columns"
            elif not heads_a_table(parsed.columns):
                outcome.reason = (
                    f"row 1 names only {named_columns(parsed.columns)} of "
                    f"{len(parsed.columns)} columns: a pivot or dashboard layout, not a "
                    f"table. {parsed.total_rows} row(s) left in the source."
                )
            elif parsed.total_rows == 0:
                outcome.reason = "a header row and no data under it"
            else:
                written = _write(
                    destination,
                    sheet_title(sheet_name),
                    parsed.columns,
                    ([row.get(name) for name in parsed.columns] for row in parsed.rows),
                )
                outcome.rows = written
                outcome.path = destination

    except Exception as exc:  # noqa: BLE001 — the message is what the admin acts on
        outcome.reason = f"{type(exc).__name__}: {exc}"
        outcome.failed = True

    outcome.seconds = time.perf_counter() - started
    return outcome


def split_workbook(
    source: Path, out_dir: Path, only: Iterable[str] | None = None
) -> list[SheetOutcome]:
    """One file per sheet in `out_dir`, and one outcome per sheet in return.

    `only` re-splits a subset by name. The ordinal in each filename stays the
    sheet's position in the WORKBOOK rather than its position in this run, so a
    one-sheet re-split overwrites the file a full split wrote instead of
    producing a second copy under a different number.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = {name.strip().lower() for name in only} if only is not None else None

    outcomes: list[SheetOutcome] = []
    for index, info in enumerate(list_sheets(source), start=1):
        if wanted is not None and info.name.strip().lower() not in wanted:
            continue
        outcomes.append(split_sheet(source, out_dir, index, info.name))
    return outcomes


# ── cli ────────────────────────────────────────────────────────────────────


def _report(outcomes: list[SheetOutcome], out_dir: Path, elapsed: float) -> None:
    width = max((len(o.sheet_name) for o in outcomes), default=5)
    print(f"{'sheet'.ljust(width)}    rows   cols     secs  output")
    print("-" * (width + 60))

    for outcome in outcomes:
        rows = f"{outcome.rows:,}" if outcome.path else "-"
        cols = f"{outcome.columns:,}" if outcome.path else "-"
        tail = outcome.path.name if outcome.path else f"SKIPPED: {outcome.reason}"
        print(f"{outcome.sheet_name.ljust(width)}  {rows:>6} {cols:>6} {outcome.seconds:8.2f}  {tail}")
        for note in outcome.notes:
            print(f"{' ' * width}          {note}")

    written = [o for o in outcomes if o.path]
    print(
        f"\n{len(written)} of {len(outcomes)} sheet(s) written, "
        f"{sum(o.rows for o in written):,} rows, in {elapsed:.2f}s -> {out_dir}"
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: python -m app.split <workbook> <output-dir> [sheet ...]", file=sys.stderr)
        return 2

    source, out_dir = Path(argv[0]), Path(argv[1])
    if not source.is_file():
        print(f"No workbook at {source}", file=sys.stderr)
        return 2

    started = time.perf_counter()
    outcomes = split_workbook(source, out_dir, argv[2:] or None)
    _report(outcomes, out_dir, time.perf_counter() - started)

    # Skipping a dashboard is a decision and exits 0; a sheet that RAISED is not,
    # and a script that pipes this into an upload has to be able to tell them
    # apart without parsing the table.
    return 1 if any(o.failed for o in outcomes) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
