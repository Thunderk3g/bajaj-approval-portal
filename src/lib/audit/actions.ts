/**
 * The closed set of auditable actions.
 *
 * Kept as a `const` array rather than a TypeScript-only union so the same list
 * is available at runtime — filter dropdowns, validation of an action name
 * arriving from outside, and the seed of any reporting query all read from
 * here. A string literal that is not in this list is a compile error, which is
 * the point: an audit trail whose vocabulary drifts silently is not a trail.
 */
export const AUDIT_ACTIONS = [
  'AUTH_LOGIN',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',

  'USER_CREATE',
  'USER_UPDATE',
  'USER_DEACTIVATE',

  'UPLOAD_CREATE',
  'UPLOAD_MAPPING_SET',
  'UPLOAD_VALIDATE',
  'UPLOAD_COMMIT',
  'UPLOAD_ABORT',
  /**
   * A `Lead Dump` import was started for this upload.
   *
   * Separate from UPLOAD_COMMIT because it is a separate decision with a
   * separate outcome: leads are a read-only view scoped by SM code, and an admin
   * may import them for a batch whose transaction rows are still being reviewed.
   */
  'UPLOAD_LEADS_IMPORT',
  /**
   * The upload row, its staged rows and its stored file are gone.
   *
   * Distinct from UPLOAD_ABORT, which keeps all three. This entry is the ONLY
   * remaining evidence that the file was ever uploaded, which is why the action
   * writes it before deleting anything and copies the file name and hash into
   * `before` — after the fact there is nothing left to join to.
   */
  'UPLOAD_DELETE',
  'UPLOAD_ORIGINAL_DOWNLOAD',

  'RECORD_UPDATE',
  'RECORD_CONFLICT_RESOLVE',
  'RECORD_LOOKUP',

  'CORRECTION_SUBMIT',
  'CORRECTION_RESUBMIT',
  /** The first gate — 2026-07-28 spec section 3. */
  'CORRECTION_VERIFY',
  /**
   * A return issued by a VERIFIER, distinct from CORRECTION_RETURN.
   *
   * Both produce a RETURNED request, so the status column cannot tell them
   * apart after the fact. Separating them here is what lets an audit answer
   * "how much is the verification stage sending back" — the number that says
   * whether the gate is doing work or waving things through.
   */
  'CORRECTION_RETURN_VERIFIER',
  'CORRECTION_APPROVE',
  'CORRECTION_REJECT',
  'CORRECTION_RETURN',
  'CORRECTION_WITHDRAW',

  'ATTACHMENT_UPLOAD',
  'ATTACHMENT_VIEW',

  'EXPORT_GENERATE',
  'EXPORT_DOWNLOAD',

  /** The monthly cycle — 2026-07-28 spec section 4.4. */
  'PERIOD_OPEN',
  'PERIOD_CLOSE',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
