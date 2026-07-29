"""The write path, without a database.

`collapse_duplicate_lead_nos` is pure and is the whole fix for a failure that
took the first real end-to-end run down 1.1 seconds in, having written nothing:

    ON CONFLICT DO UPDATE command cannot affect row a second time

Postgres refuses a single statement that proposes the same constrained value
twice, and the real `Lead Dump` repeats 135 lead numbers across 54,507 rows. The
`executemany` this batching replaced never met the problem — one statement per
row means a repeat simply updates what the earlier row wrote — so the bug arrived
with the optimisation and is invisible to any test that does not batch.
"""

from __future__ import annotations

import pytest

from app.db import MAX_ROWS_PER_STATEMENT, _LEAD_COLUMNS, collapse_duplicate_lead_nos


def row(lead_no: str, sm_code: str) -> tuple:
    """A lead row shaped like the real one: lead_no first, sm_code second."""
    values: list[object] = [None] * len(_LEAD_COLUMNS)
    values[0] = lead_no
    values[1] = sm_code
    return tuple(values)


def test_lead_no_is_the_first_column():
    """collapse_duplicate_lead_nos indexes row[0]. If the column order ever
    changes, it would silently de-duplicate on whatever moved into that slot —
    which for `sm_code` would collapse every lead a rep owns down to one."""
    assert _LEAD_COLUMNS[0] == "lead_no"


def test_a_chunk_with_no_repeats_is_unchanged():
    rows = [row("L1", "ICCS1"), row("L2", "ICCS2"), row("L3", "ICCS3")]
    assert collapse_duplicate_lead_nos(rows) == rows


def test_the_last_occurrence_wins():
    """File order is chronological, so the later row is the more recent statement
    about that lead. Keeping the first would freeze a lead at a superseded owner
    — the same failure as ON CONFLICT DO NOTHING, and the reason this is an
    upsert at all."""
    collapsed = collapse_duplicate_lead_nos(
        [row("L1", "OLD_OWNER"), row("L2", "ICCS2"), row("L1", "NEW_OWNER")]
    )

    assert [r[0] for r in collapsed] == ["L1", "L2"]
    assert collapsed[0][1] == "NEW_OWNER"


def test_order_of_surviving_rows_is_preserved():
    """Not cosmetic: the rows are flattened positionally into the statement's
    placeholders, so a reordering here would still be correct SQL — which is
    exactly why a regression would be silent."""
    collapsed = collapse_duplicate_lead_nos(
        [row("A", "1"), row("B", "2"), row("C", "3"), row("A", "4")]
    )
    assert [r[0] for r in collapsed] == ["A", "B", "C"]


def test_an_all_duplicate_chunk_collapses_to_one():
    collapsed = collapse_duplicate_lead_nos([row("L1", str(i)) for i in range(50)])
    assert len(collapsed) == 1
    assert collapsed[0][1] == "49"


def test_an_empty_chunk_stays_empty():
    assert collapse_duplicate_lead_nos([]) == []


def test_collapsing_never_grows_a_chunk_past_the_statement_limit():
    """The chunk size check in upsert_leads runs BEFORE the collapse, so this
    could only fail if collapsing added rows. Asserted anyway because the two
    are separated by the raise, and a future edit that swapped their order would
    otherwise be caught only by Postgres rejecting the parameter count."""
    rows = [row(f"L{i % 10}", str(i)) for i in range(MAX_ROWS_PER_STATEMENT)]
    assert len(collapse_duplicate_lead_nos(rows)) <= MAX_ROWS_PER_STATEMENT


def test_none_is_a_distinct_key_and_is_not_conflated_with_a_string():
    """row_to_lead refuses a row without a lead number, so None should never
    reach here. If it ever did, collapsing it into a real lead would delete that
    lead's data; keeping it separate means the failure surfaces as a not-null
    violation from Postgres instead."""
    collapsed = collapse_duplicate_lead_nos([row("L1", "a"), (None,) + row("L1", "b")[1:]])
    assert len(collapsed) == 2


@pytest.mark.parametrize("size", [1, 2, 999, MAX_ROWS_PER_STATEMENT])
def test_distinct_lead_numbers_survive_at_every_chunk_size(size: int):
    rows = [row(f"L{i}", str(i)) for i in range(size)]
    assert len(collapse_duplicate_lead_nos(rows)) == size
