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
  /**
   * An account was deleted over the top of its own audit history.
   *
   * The entries do not survive: every row the account was the actor of is
   * deleted with it. This entry is what is left — written by the admin who
   * forced it, carrying the account's snapshot. Its own action because "which
   * accounts were removed this way, and how much of the trail went with them" is
   * a question nobody asks of an ordinary deactivation, and
   * `metadata.deletedAuditRows` is the only place the answer is recorded.
   */
  'USER_DELETE_FORCED',

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
   * The Manpower sheet was committed to the roster — step one of an import.
   *
   * Its own action, not folded into UPLOAD_COMMIT, because it is a separate
   * decision with separate consequences: this one rewrites who approves whose
   * corrections, and an auditor asking "when did the reporting line change" must
   * not have to infer it from a policy import that happened to carry the sheet.
   */
  'UPLOAD_ROSTER_COMMIT',
  /**
   * The upload row, its staged rows and its stored file are gone.
   *
   * Distinct from UPLOAD_ABORT, which keeps all three. This entry is the ONLY
   * remaining evidence that the file was ever uploaded, which is why the action
   * writes it before deleting anything and copies the file name and hash into
   * `before` — after the fact there is nothing left to join to.
   */
  'UPLOAD_DELETE',
  /**
   * The same act, taken over the top of the approved-correction guard.
   *
   * Its own action rather than a flag on UPLOAD_DELETE, because it answers a
   * question nobody asks of an ordinary deletion: which audited approvals were
   * destroyed, by whom, and when. Filtering the trail to this one action is the
   * only way to find that out, and `metadata.erasedApprovals` carries the full
   * decisions — after the cascade there is nothing left to join to.
   */
  'UPLOAD_DELETE_FORCED',
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

  /**
   * A non-final stage passed the request on — 2026-08-06 spec section 4.
   *
   * Distinct from CORRECTION_VERIFY, which keeps meaning "stage 0 of a chain
   * whose stage 0 is a verifier". An ACM handing a mapping request to the second
   * ACM verified nothing, and recording it as a verification would make the one
   * number that says whether the verification gate is doing work meaningless.
   */
  'CORRECTION_ADVANCE',

  /** The monthly cycle — 2026-07-28 spec section 4.4. */
  'PERIOD_OPEN',
  'PERIOD_CLOSE',

  /**
   * The approval chain an admin edits — 2026-08-06 spec section 7.
   *
   * Three actions rather than one CHAIN_UPDATE, because the three answer
   * different questions after the fact: a removed stage is a control that stopped
   * running, a reorder is the same controls in a different order, and only the
   * first is worth waking somebody for. All three carry the full before/after
   * stage list, so the audit log IS the version history — no separate table.
   */
  'WORKFLOW_CHAIN_STAGE_ADD',
  'WORKFLOW_CHAIN_STAGE_REMOVE',
  'WORKFLOW_CHAIN_STAGE_REORDER',

  /** An admin overriding, or releasing, the roster's own hierarchy — spec §5. */
  'HIERARCHY_REASSIGN',
  'HIERARCHY_OVERRIDE_REVERT',
  /**
   * A row was struck off the Manpower roster by hand.
   *
   * Its own action rather than a HIERARCHY_* one: those two move a person
   * between managers and are reversible from the screen that made them, while
   * this one destroys the roster's only row for a code. The entry carries the
   * whole row in `before` and how many imported records were left without an
   * owner in `metadata`, because after the fact there is nothing left to join to.
   */
  'ROSTER_ENTRY_DELETE',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
