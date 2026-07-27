/**
 * The version chain of a record — spec section 5.5.
 *
 * A version row carries a full jsonb snapshot of the record as it stood, so an
 * unscoped read of `sales_record_version` would hand a sales user every field
 * of every other rep's applications while never touching `sales_record` at all.
 * Every query here therefore joins the record table purely so it can compose
 * `scopedRecordWhere` — the join is the authorization, not a convenience.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { salesRecord, salesRecordVersion, user } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { fieldLabel } from '@/lib/fields';
import { scopedRecordWhere } from './query';

export type RecordVersion = {
  id: string;
  version: number;
  changeType: string;
  changedFields: string[] | null;
  changedAt: Date;
  note: string | null;
  correctionRequestId: string | null;
  batchId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  data: Record<string, unknown>;
};

/**
 * Newest first.
 *
 * Descending because the question a reviewer asks is "what changed last", and
 * because rendering a diff needs each version paired with the one before it —
 * which in this order is simply the next element.
 */
export async function listRecordVersions(
  viewer: SessionUser,
  appsNo: string,
): Promise<RecordVersion[]> {
  const rows = await db
    .select({
      id: salesRecordVersion.id,
      version: salesRecordVersion.version,
      changeType: salesRecordVersion.changeType,
      changedFields: salesRecordVersion.changedFields,
      changedAt: salesRecordVersion.changedAt,
      note: salesRecordVersion.note,
      correctionRequestId: salesRecordVersion.correctionRequestId,
      batchId: salesRecordVersion.batchId,
      data: salesRecordVersion.data,
      actorName: user.name,
      actorEmail: user.email,
    })
    .from(salesRecordVersion)
    .innerJoin(salesRecord, eq(salesRecord.id, salesRecordVersion.recordId))
    .leftJoin(user, eq(user.id, salesRecordVersion.changedBy))
    .where(and(scopedRecordWhere(viewer), eq(salesRecord.appsNo, appsNo)))
    .orderBy(desc(salesRecordVersion.version));

  return rows.map((row) => ({
    ...row,
    data: (row.data ?? {}) as Record<string, unknown>,
  }));
}

export type FieldDiff = { field: string; label: string; from: string | null; to: string | null };

/**
 * Bookkeeping columns, excluded from every diff.
 *
 * `updated_at` and `current_version` change on literally every write, and
 * `has_corrections` flips as a side effect of the workflow rather than as an
 * edit anybody made. Listing them alongside the one field a correction actually
 * changed is how a two-line diff becomes a six-line one nobody reads.
 */
const BOOKKEEPING_KEYS = new Set([
  'id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'currentVersion',
  'current_version',
  'hasCorrections',
  'has_corrections',
  'sourceBatchId',
  'source_batch_id',
  'sourceRowNumber',
  'source_row_number',
]);

/** Snapshots are jsonb, so a value can be any scalar, null, or a nested object. */
function display(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return text.trim() === '' ? null : text;
}

/**
 * Turns two adjacent snapshots into the field/from/to triples the UI renders.
 *
 * Computed from the snapshots rather than trusted from `changed_fields`:
 * `changed_fields` is written by whatever produced the version and is a label
 * for humans, whereas the snapshots are the evidence. If the two ever disagree,
 * the snapshots are what actually happened to the record.
 *
 * `extra` is descended one level so a corrected `Source` or `RECEIPT_NO` reads
 * as `extra.Source` with real before/after values, instead of two walls of JSON
 * the reviewer has to diff by eye.
 */
export function diffSnapshots(
  previous: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined,
): FieldDiff[] {
  const before = previous ?? {};
  const after = current ?? {};
  const diffs: FieldDiff[] = [];

  for (const key of union(before, after)) {
    if (BOOKKEEPING_KEYS.has(key)) continue;

    const from = before[key];
    const to = after[key];

    if (key === 'extra' && isPlainObject(from ?? {}) && isPlainObject(to ?? {})) {
      const fromExtra = (from ?? {}) as Record<string, unknown>;
      const toExtra = (to ?? {}) as Record<string, unknown>;
      for (const inner of union(fromExtra, toExtra)) {
        push(diffs, `extra.${inner}`, `Extra · ${inner}`, fromExtra[inner], toExtra[inner]);
      }
      continue;
    }

    push(diffs, key, fieldLabel(key), from, to);
  }

  return diffs;
}

function push(out: FieldDiff[], field: string, label: string, from: unknown, to: unknown) {
  const a = display(from);
  const b = display(to);
  if (a === b) return;
  out.push({ field, label, from: a, to: b });
}

function union(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type VersionWithDiff = RecordVersion & { diffs: FieldDiff[]; isBaseline: boolean };

/**
 * Pairs each version with the one before it.
 *
 * Version 1 is always the untouched imported row (section 5.5), so it has no
 * predecessor and no diff — it is the baseline the rest are measured against,
 * and labelling it as such is more honest than showing every field as "added".
 */
export function versionChain(versions: RecordVersion[]): VersionWithDiff[] {
  return versions.map((version, index) => {
    const previous = versions[index + 1];
    return {
      ...version,
      isBaseline: previous === undefined,
      diffs: previous ? diffSnapshots(previous.data, version.data) : [],
    };
  });
}
