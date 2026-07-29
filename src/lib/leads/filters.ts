/**
 * URL search params to a typed lead filter — 2026-07-28 ingestion spec, section 6.
 *
 * Same contract as `records/filters.ts`, and for the same reason: a lead list is
 * a page people bookmark, share and hand-edit, so `?registerFrom=last-week` has
 * to degrade to "no date filter" rather than to a stack trace. Every field is
 * parsed by a schema whose `.catch(null)` swallows the failure, which keeps the
 * "ignore what you cannot read" rule in one place.
 *
 * Deliberately free of any database import: this is pure string handling, so it
 * is unit-testable without a connection and cannot quietly become the place a
 * query gets built.
 */

import { z } from 'zod';
import type { Role } from '@/lib/auth/rbac';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Ownership is a three-way choice rather than an "exclude unassigned" checkbox.
 *
 * The `111222-UN` sentinel covers about 2.7% of the sheet, and those are real
 * leads waiting to be given to someone — not rows to be filtered out and
 * forgotten. Making the pool its own selectable view is what turns it into a
 * worklist for the admin instead of a silent remainder.
 */
export const LEAD_OWNERSHIPS = ['ALL', 'ASSIGNED', 'UNASSIGNED'] as const;
export type LeadOwnership = (typeof LEAD_OWNERSHIPS)[number];

export const LEAD_OWNERSHIP_LABELS: Record<LeadOwnership, string> = {
  ALL: 'Everyone',
  ASSIGNED: 'Assigned to a rep',
  UNASSIGNED: 'Unassigned — waiting for an owner',
};

export type LeadFilters = {
  q: string | null;
  /** Admin only. Null for every other role — see `parseLeadFilters`. */
  smCode: string | null;
  ownership: LeadOwnership;
  registerFrom: string | null;
  registerTo: string | null;
};

export const DEFAULT_OWNERSHIP: LeadOwnership = 'ALL';

export const EMPTY_LEAD_FILTERS: LeadFilters = Object.freeze({
  q: null,
  smCode: null,
  ownership: DEFAULT_OWNERSHIP,
  registerFrom: null,
  registerTo: null,
});

/** Repeated params (`?q=a&q=b`) collapse to the first — a filter is single-valued. */
function first(value: string | string[] | undefined): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A bounded, trimmed, non-empty string or nothing.
 *
 * The length cap is not cosmetic: `q` becomes an `ILIKE '%…%'` pattern over
 * fifty thousand rows, and an unbounded term from a crafted URL is a cheap way
 * to make the database do expensive work on demand.
 */
const text = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);

const isoDate = z.iso.date().nullable().catch(null);

const SCHEMA = {
  q: text(120),
  smCode: text(64),
  ownership: z.enum(LEAD_OWNERSHIPS).catch(DEFAULT_OWNERSHIP),
  registerFrom: isoDate,
  registerTo: isoDate,
};

/**
 * @param viewer the *session* role, never a request parameter.
 *
 * The `SM_CODE` filter is admin-only. Dropping it here is the readable half of
 * the defence; the load-bearing half is that `leadWhere` ANDs every filter with
 * `scopedLeadCondition`, so even if this function were bypassed entirely a sales
 * user's `?smCode=SOMEONE_ELSE` could only ever narrow their own leads to
 * nothing — never widen them.
 */
export function parseLeadFilters(params: SearchParams, viewer: { role: Role }): LeadFilters {
  const read = <T>(schema: { parse: (v: unknown) => T }, key: string): T =>
    schema.parse(first(params[key]));

  const smCode = viewer.role === 'admin' ? read(SCHEMA.smCode, 'smCode') : null;

  return {
    q: read(SCHEMA.q, 'q'),
    // Uppercased to match the CHECK constraint on lead.sm_code: a lowercase
    // filter value would silently match nothing at all, which reads to an admin
    // as "this rep has no leads" rather than as "you typed it wrong".
    smCode: smCode ? smCode.toUpperCase() : null,
    ownership: read(SCHEMA.ownership, 'ownership'),
    registerFrom: read(SCHEMA.registerFrom, 'registerFrom'),
    registerTo: read(SCHEMA.registerTo, 'registerTo'),
  };
}

/** True when anything is narrowing the list — drives the "Clear" affordance. */
export function hasActiveLeadFilters(filters: LeadFilters): boolean {
  return (
    filters.q !== null ||
    filters.smCode !== null ||
    filters.ownership !== DEFAULT_OWNERSHIP ||
    filters.registerFrom !== null ||
    filters.registerTo !== null
  );
}

/** The form control values for a parsed filter set — empty string is "unset" in a `<select>`. */
export function leadFilterFormValues(filters: LeadFilters): Record<string, string> {
  return {
    q: filters.q ?? '',
    smCode: filters.smCode ?? '',
    ownership: filters.ownership,
    registerFrom: filters.registerFrom ?? '',
    registerTo: filters.registerTo ?? '',
  };
}
