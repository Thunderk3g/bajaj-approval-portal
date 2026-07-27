/**
 * Turns an audit row's `before` / `after` jsonb into something a person can
 * read at a glance — spec section 5.9.
 *
 * Two whole JSON blobs side by side is not a diff; on a `sales_record` snapshot
 * with twenty-odd fields the reviewer has to spot the one that moved. This
 * collapses the pair to the keys that actually changed, which is the only part
 * anyone is auditing.
 *
 * Deliberately shallow. A nested object is compared by its serialization and
 * shown whole rather than walked: the payloads written by this system are flat
 * field snapshots, and a recursive walk would invent a structure the data does
 * not have while making an infinitely deep object a denial-of-service surface.
 */

export type DiffEntry = { key: string; before: string | null; after: string | null };

export type PayloadShape =
  | { kind: 'none' }
  | { kind: 'diff'; entries: DiffEntry[] }
  | { kind: 'raw'; before: string | null; after: string | null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Renders one jsonb leaf. `null` is a value in an audit trail, not an absence. */
export function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Keys present in either side whose values differ, in a stable order.
 *
 * A key that appears on only one side counts as a change: `after` gaining a
 * field is exactly the kind of thing worth seeing, and treating a missing key
 * as "unchanged" would hide it.
 */
export function diffEntries(before: unknown, after: unknown): DiffEntry[] {
  if (!isPlainObject(before) || !isPlainObject(after)) return [];

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const entries: DiffEntry[] = [];

  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    const same =
      key in before && key in after && JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (same) continue;

    entries.push({
      key,
      before: key in before ? formatValue(a) : null,
      after: key in after ? formatValue(b) : null,
    });
  }

  return entries;
}

/** Pretty JSON for the cases a key-level diff cannot describe. */
function pretty(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, null, 2);
}

/**
 * Decides how one row's payload should be presented.
 *
 * A creation (`before` null) and a deactivation (`after` a single flag) are not
 * diffs — there is nothing to compare against — so they fall through to
 * formatted JSON rather than being forced into a two-column shape that would
 * imply a change that never happened.
 */
export function describePayload(before: unknown, after: unknown): PayloadShape {
  if (before === null && after === null) return { kind: 'none' };
  if (before === undefined && after === undefined) return { kind: 'none' };

  if (isPlainObject(before) && isPlainObject(after)) {
    return { kind: 'diff', entries: diffEntries(before, after) };
  }

  return { kind: 'raw', before: pretty(before), after: pretty(after) };
}
