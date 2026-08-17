import { z } from 'zod';
import { CATEGORY_FIELDS, FIELD_BY_KEY, fieldLabel } from '@/lib/fields';
import {
  normalizeAutopay,
  normalizeIdentifier,
  normalizeMoney,
  normalizeSmId,
  normalizeStatus,
  normalizeString,
  type NormalizeResult,
} from '@/lib/import/normalize';
import { normalizeDate } from '@/lib/import/dates';

/**
 * Correction validation — spec section 7.1.
 *
 * A discriminated union, not one object with optional fields. The categories do
 * not share a shape: `OTHERS` needs a field name and a description that no other
 * branch requires, and `AUTOPAY` accepts a vocabulary of two values that would
 * be meaningless on `ISSUANCE_DATE`. Expressed as optional fields on a single
 * object, every one of those rules degrades into a runtime `if` that a later
 * edit can drop silently; expressed as a union, the wrong shape does not parse.
 *
 * This is the SECOND of three enforcements of the "Others needs a description"
 * rule. The form marks the field required (a convenience), this union rejects it
 * (the control), and `correction_others_requires_description` in the database
 * rejects it again (the backstop). Client-side requiredness is never the
 * control: the action is reachable without the form.
 */

export const CORRECTION_CATEGORIES = [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'AGENT_ID',
  'OTHERS',
] as const;
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

/**
 * Listed before OTHERS, though the database enum appends it last.
 *
 * The two orders answer different questions and are allowed to differ: the enum
 * order is a storage detail Postgres fixes at ALTER TYPE time, this one is what
 * a rep reads down in the category dropdown, and OTHERS belongs at the bottom of
 * that list because it is the fallback for everything the named ones do not
 * cover. Nothing joins the two — every consumer keys by value.
 */
export const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  AUTOPAY: 'AutoPay',
  MAPPING: 'Mapping (SM attribution)',
  ISSUANCE_DATE: 'Issuance date',
  AGENT_ID: 'Agent ID',
  OTHERS: 'Other field',
};

/**
 * The two ways a mapping correction can move a sale — 2026-07-29 spec section 2.
 *
 * Mirrors `mappingDirectionEnum` in the schema. Kept as a `const` array so the
 * values are available at runtime for the form's radio group and for Zod, the
 * same shape `CORRECTION_CATEGORIES` uses.
 */
export const MAPPING_DIRECTIONS = ['CLAIM_IN', 'TRANSFER_OUT'] as const;
export type MappingDirection = (typeof MAPPING_DIRECTIONS)[number];

export const DESCRIPTION_MAX = 2000;

const OTHERS_DESCRIPTION_MESSAGE =
  'An "Other field" correction needs a description explaining what is wrong.';

/**
 * The `<input type="date">` wire format, and the only one accepted here.
 *
 * The importer takes a per-batch `dateFormat` because a workbook can spell
 * dates any way it likes. A correction form cannot: `03/04/2026` is either
 * 3 April or 4 March, and a wrong guess corrupts an issuance date in a way that
 * leaves no trace. The browser always submits ISO, so ISO is all we accept.
 */
const FORM_DATE_FORMAT = 'yyyy-MM-dd' as const;

/** Matches the importer's plausibility floor so the two cannot disagree. */
export const ISSUED_DATE_MIN = '1990-01-01';

/**
 * One day of headroom past today, not zero.
 *
 * The server compares in UTC and the reps work in IST (UTC+5:30), so for five
 * and a half hours every evening a rep's "today" is already tomorrow in UTC.
 * Without the headroom they would be told today's date is in the future.
 */
export function issuedDateMax(now: Date = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function isPlausibleIssuedDate(iso: string, now: Date = new Date()): boolean {
  return iso >= ISSUED_DATE_MIN && iso <= issuedDateMax(now);
}

/**
 * `OTHERS` may name any canonical field except the record's own identity, and
 * except the one field that has a category of its own.
 *
 * `apps_no` is the unique key every correction, version row and audit entry
 * points at. "Correcting" it would either collide with another record or orphan
 * the request's own history — a re-import is the way to fix a wrong application
 * number, not a correction.
 *
 * `sm_id` is forbidden for a different reason — 2026-07-29 spec section 9. Not
 * that it must never change, but that it must never change THIS way. An
 * `OTHERS` request naming `smId` reaches the apply path with
 * `category !== 'MAPPING'`, so `applyApprovalWithin` skips its whole mapping
 * branch: `sm_id` is rewritten while `sm_name` keeps the PREVIOUS rep's name —
 * the divergence section 6.7 forbids and the branch exists to prevent —
 * `changedFields` records one column instead of two, and neither rep is
 * notified, so the record leaves one book and enters another in silence.
 *
 * That was a real hole, not a hypothetical: it was the only way to push a sale
 * out before `TRANSFER_OUT` existed. Now that reassignment has a sanctioned path
 * in both directions, nothing legitimate needs this one.
 */
export const OTHERS_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(['appsNo', 'smId']);

export const OTHERS_FIELD_CHOICES = CATEGORY_FIELDS.OTHERS.filter(
  (key) => !OTHERS_FORBIDDEN_FIELDS.has(key),
);

/**
 * Routes a proposed value through the SAME normalizer the importer uses.
 *
 * Without this a correction becomes a back door around section 6.3: a rep types
 * `y` for AutoPay or `c2cm21350` for an SM_ID, the approver waves it through,
 * and the record now holds a form the importer would never have produced — one
 * that splits the rep's book in half, or that the `sales_record_sm_id_uppercase`
 * CHECK rejects outright at the moment of applying. Normalizing here means a
 * correction can only ever store a value the import path would also have stored.
 */
export function normalizeProposedValue(fieldKey: string, raw: unknown): NormalizeResult<string> {
  const field = FIELD_BY_KEY.get(fieldKey);

  if (!field) {
    return {
      value: null,
      issues: [
        {
          field: fieldKey,
          code: 'FIELD_UNKNOWN',
          severity: 'ERROR',
          message: `"${fieldKey}" is not a field on a sales record.`,
        },
      ],
    };
  }

  // SM_ID is registered as plain text but is not plain text: it is the scoping
  // key, and the mixed-case pairs in the source (`c2cm21350` / `C2CM21350`) are
  // the same rep. Uppercasing is what keeps a book whole.
  if (fieldKey === 'smId') return normalizeSmId(raw);

  switch (field.kind) {
    case 'identifier':
      return normalizeIdentifier(raw, fieldKey);
    case 'date':
      return normalizeDate(raw, FORM_DATE_FORMAT, field.label);
    case 'money':
      return normalizeMoney(raw, fieldKey);
    case 'autopay':
      return normalizeAutopay(raw);
    case 'status':
      return normalizeStatus(raw);
    case 'text':
      return { value: normalizeString(raw), issues: [] };
  }
}

/* ------------------------------------------------------------------ pieces */

const appsNoField = z
  .string()
  .trim()
  .min(1, 'Enter the application number.')
  .max(64, 'That is not an application number.');

const optionalDescription = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX, `Keep the description under ${DESCRIPTION_MAX} characters.`)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

/* ---------------------------------------------------------------- branches */

const autopayBranch = z.object({
  category: z.literal('AUTOPAY'),
  appsNo: appsNoField,
  // Parsed through the importer's vocabulary so `y`, `YES` and `Yes` all land on
  // the stored value, and anything outside the vocabulary is refused rather than
  // kept as free text — the whole point of the category is a binary answer.
  proposedValue: z
    .string()
    .trim()
    .transform((raw) => normalizeAutopay(raw).value ?? '')
    .refine((value) => value === 'Yes' || value === 'No', {
      message: 'AutoPay must be either Yes or No.',
    }),
  description: optionalDescription,
});

const mappingBranch = z.object({
  category: z.literal('MAPPING'),
  /**
   * Which way the sale moves — 2026-07-29 spec section 2.
   *
   * The two directions share this whole branch because their *shape* is
   * identical: an identifier, a destination SM_ID, an optional note. What
   * separates them cannot be expressed here at all — `CLAIM_IN` pins the
   * destination to the submitter's own SM_ID, `TRANSFER_OUT` requires it to be
   * someone else's and present in the roster. Both need the session or the
   * database, so both live in the service. Splitting the branch to say so would
   * produce two identical object schemas.
   */
  direction: z.enum(MAPPING_DIRECTIONS, {
    error: 'Choose whether you are claiming this sale or transferring it out.',
  }),
  /**
   * For `CLAIM_IN` this is an application number and nothing else — section 7.2
   * pins the cross-book lookup to an exact `Apps_No` match.
   *
   * For `TRANSFER_OUT` it may be an application OR a policy number: the rep
   * already owns the record, so resolution happens inside their own book and
   * needs no scoping exception. `resolveOwnRecord` in the service decides which
   * it is; whichever was typed, the record's real `apps_no` is what gets stored.
   */
  appsNo: appsNoField,
  /**
   * The SM_ID the sale should end up with.
   *
   * For `CLAIM_IN` the service pins this to the claimant's own SM_ID — section
   * 7.2: approval moves the record to the *claimant*, so a rep naming a third
   * party would produce an approval that does something other than what the
   * request said. For `TRANSFER_OUT` naming someone else is the entire point,
   * and the service checks it is not the submitter and is known to the roster.
   */
  proposedValue: z
    .string()
    .trim()
    .transform((raw) => normalizeSmId(raw).value ?? '')
    .refine((value) => value.length > 0, { message: 'Enter the SM ID the sale belongs to.' }),
  description: optionalDescription,
});

const issuanceDateBranch = z.object({
  category: z.literal('ISSUANCE_DATE'),
  appsNo: appsNoField,
  proposedValue: z
    .string()
    .trim()
    .transform((raw) => normalizeDate(raw, FORM_DATE_FORMAT, 'Issued date').value ?? '')
    .refine((value) => value !== '' && isPlausibleIssuedDate(value), {
      message: `Enter an issuance date between ${ISSUED_DATE_MIN} and today.`,
    }),
  description: optionalDescription,
});

/**
 * The `Agent_ID` correction — one identifier and nothing else.
 *
 * Deliberately thin. There is no roster to check an agent code against the way
 * `checkTransferTarget` checks an SM_ID, and inventing one would refuse every
 * correction naming an agent the portal has not seen yet — which is most of
 * them, since the column arrived after go-live and only three distinct codes
 * appear in the June file.
 *
 * `normalizeIdentifier`, matching the field's `identifier` kind, so a corrected
 * agent code and an imported one are the same string. It is what refuses
 * `5.92E+09` — a real hazard here, because the codes are ten-digit numbers that
 * spend their lives in Excel — rather than storing the display text of a value
 * that already lost its digits.
 *
 * The cap matches `appsNoField`; the real codes are ten characters. Nothing
 * downstream truncates, so without it a pasted paragraph becomes a permanent
 * `agent_id` and the queue's change column renders it in full.
 */
const agentIdBranch = z.object({
  category: z.literal('AGENT_ID'),
  appsNo: appsNoField,
  proposedValue: z
    .string()
    .trim()
    .max(64, 'That is not an agent code.')
    .transform((raw) => normalizeIdentifier(raw, 'agentId').value ?? '')
    .refine((value) => value.length > 0, {
      // Covers all three ways the transform yields nothing: empty, a source
      // sentinel like `-`, and scientific notation, which is refused rather
      // than expanded because expanding it would invent digits.
      message: 'Enter the agent code as it appears on the dashboard, e.g. 3000000007 or 59L0000000.',
    }),
  description: optionalDescription,
});

const othersBranch = z.object({
  category: z.literal('OTHERS'),
  appsNo: appsNoField,
  fieldName: z
    .string()
    .trim()
    .min(1, 'Choose the field that needs correcting.')
    .refine((key) => FIELD_BY_KEY.has(key) && !OTHERS_FORBIDDEN_FIELDS.has(key), {
      message: 'That is not a field a correction can change.',
    }),
  proposedValue: z.string().trim().min(1, 'Enter the value the field should hold.'),
  description: z
    .string({ error: OTHERS_DESCRIPTION_MESSAGE })
    .trim()
    .min(1, OTHERS_DESCRIPTION_MESSAGE)
    .max(DESCRIPTION_MAX, `Keep the description under ${DESCRIPTION_MAX} characters.`),
});

export const correctionSubmitSchema = z
  .discriminatedUnion('category', [
    autopayBranch,
    mappingBranch,
    issuanceDateBranch,
    agentIdBranch,
    othersBranch,
  ])
  // The other three branches know their target field at compile time and
  // normalize in-branch. OTHERS only learns it from a sibling property, so its
  // value check has to happen once both are parsed.
  .superRefine((input, ctx) => {
    if (input.category !== 'OTHERS') return;

    const { value, issues } = normalizeProposedValue(input.fieldName, input.proposedValue);
    const blocking = issues.filter((issue) => issue.severity === 'ERROR');

    if (value === null || blocking.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['proposedValue'],
        message: blocking[0]?.message ?? `Enter a valid ${fieldLabel(input.fieldName)}.`,
      });
    }
  });

export type CorrectionSubmitInput = z.infer<typeof correctionSubmitSchema>;
export type CorrectionSubmitRawInput = z.input<typeof correctionSubmitSchema>;

/**
 * The record column a parsed submission targets.
 *
 * Reads the category-to-field table out of `CATEGORY_FIELDS` rather than
 * restating it, so the registry stays the single place that decides which field
 * a category owns.
 */
export function targetFieldFor(input: CorrectionSubmitInput): string {
  if (input.category === 'OTHERS') return input.fieldName;

  const [field] = CATEGORY_FIELDS[input.category];
  if (!field) throw new Error(`No target field registered for category ${input.category}`);
  return field;
}

/* --------------------------------------------------------- other envelopes */

export const requestIdSchema = z.uuid('That is not a request id.');

export const resubmitSchema = z.object({
  requestId: requestIdSchema,
  proposedValue: z.string(),
  description: z.string().optional(),
});

export type ResubmitInput = z.infer<typeof resubmitSchema>;

export const withdrawSchema = z.object({
  requestId: requestIdSchema,
  reason: z.string().trim().max(DESCRIPTION_MAX).optional(),
});

/**
 * The section 7.2 lookup input.
 *
 * Deliberately narrow. Exact match only: no wildcard, no prefix, no length
 * below the shape of a real application number. A sales user is being handed a
 * read across every rep's book, and the only thing that keeps that safe is that
 * it answers one question — "who owns THIS application?" — and refuses every
 * broader one.
 */
export const lookupSchema = z.object({
  appsNo: z
    .string()
    .trim()
    .min(1, 'Enter the full application number.')
    .max(64, 'That is not an application number.'),
});
