import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, manpower, manpowerOverride, salesRecord, user } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { createUserAccount } from '@/lib/auth/provision';
import type { SessionUser } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { pgError } from '@/lib/db-errors';
import { isPlaceholderCode, PLACEHOLDER_REASON } from '@/lib/roster/placeholders';
import {
  emailForRosterEntry,
  rosterKey,
  RUNG_LABELS,
  type RosterRung,
} from '@/lib/roster/entries';
import { createUserSchema, updateUserSchema, SM_ID_PATTERN } from './schema';
import { listRoster, rosterStatus } from './queries';

/**
 * Account administration — spec section 4.2.
 *
 * The actor is an explicit parameter rather than something read from the
 * session in here. These functions are called from Server Actions that have
 * already established who is asking, and keeping the resolution there means the
 * authorization check and the audit actor are the same value by construction —
 * they cannot drift into an action that checks one identity and logs another.
 * It also lets the invariants below be tested without forging a session cookie.
 */

type Actor = Pick<SessionUser, 'id' | 'email' | 'role'>;

/** The fields worth carrying into the audit trail. Never the password. */
function snapshot(row: {
  name: string;
  email: string;
  role: string;
  smId: string | null;
  isActive: boolean;
}) {
  return {
    name: row.name,
    email: row.email,
    role: row.role,
    smId: row.smId,
    isActive: row.isActive,
  };
}

export async function createUser(
  actor: Actor,
  raw: unknown,
): Promise<ActionResult<{ id: string; email: string }>> {
  const parsed = createUserSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const input = parsed.data;

  // Recorded from the database, not from a hidden form field: whether this
  // SM_ID is a real roster entry or an orphan (section 13.2 note 7) is a fact
  // about the data, and an admin reviewing the trail later needs the fact, not
  // whatever the page happened to render at the time.
  const roster = input.smId ? await rosterStatus(input.smId) : null;

  /**
   * A scoped account has to land somewhere the roster already knows.
   *
   * The chain resolves a rep's approvers by looking up their SM_ID in the roster
   * and following `tl_id`, then that team's `ccm_id`. An account whose code the
   * roster does not carry therefore resolves to nobody at both manager rungs —
   * its mapping corrections skip the two people who were supposed to see them and
   * reach the approver signed off by fewer hands, with nothing on any screen
   * saying so.
   *
   * Refused here rather than warned about, and for all three scoped roles: a TL
   * code no rep reports under is a team leader with no team, and an ACM code no
   * team sits beneath is an area manager with nothing to manage.
   */
  const placement = await checkScopeIsOnRoster(input);
  if (placement) return placement;

  let created: { id: string; email: string };
  try {
    created = await createUserAccount({
      name: input.name,
      email: input.email,
      password: input.password,
      role: input.role,
      smId: input.smId,
      tlCode: input.tlCode,
      acmCode: input.acmCode,
    });
  } catch (error) {
    // createUserAccount throws for a duplicate email, a sales account with no
    // SM_ID, and a short password. All three are the administrator's input, so
    // they belong on the form rather than on an error page.
    const message = error instanceof Error ? error.message : 'Could not create the account.';
    return fail(message);
  }

  await writeAudit({
    actor,
    action: 'USER_CREATE',
    entityType: 'user',
    entityId: created.id,
    after: { name: input.name, email: input.email, role: input.role, smId: input.smId },
    metadata: {
      // 'absent' means the SM_ID appears nowhere in the roster at all. Flagged
      // rather than blocked — section 13.2 note 7 requires the account be
      // creatable and surfaced for admin review.
      roster: roster ?? 'not_applicable',
      needsRosterReview: roster === 'absent' || roster === 'orphan',
    },
  });

  return ok({ id: created.id, email: created.email });
}

/**
 * Refuses a scoped account whose code the roster does not place, or null to
 * allow it.
 *
 * Returns the `fail` rather than throwing so the message lands on the field the
 * administrator has to change, which is the whole difference between "fix this
 * code" and a red banner over a form they have to re-read.
 */
async function checkScopeIsOnRoster(input: {
  role: string;
  smId: string | null;
  tlCode: string | null;
  acmCode: string | null;
}): Promise<ActionResult<{ id: string; email: string }> | null> {
  if (input.role === 'sales' && input.smId) {
    // Refused before the roster is even consulted: these codes DO have roster
    // rows, so "is it on the roster" answers yes for a bucket.
    if (isPlaceholderCode(input.smId)) {
      return fail('Check the highlighted fields.', {
        smId: [`${input.smId} is ${PLACEHOLDER_REASON}. It cannot hold a login.`],
      });
    }

    const [row] = await db
      .select({ tlId: manpower.tlId, isOrphan: manpower.isOrphan })
      .from(manpower)
      .where(eq(manpower.smId, input.smId))
      .limit(1);

    if (!row || row.isOrphan) {
      return fail('Check the highlighted fields.', {
        smId: [
          `${input.smId} is not on the Manpower roster, so this account would have no team leader or area manager to route its corrections through. Import an up-to-date roster first.`,
        ],
      });
    }
    if (!row.tlId) {
      return fail('Check the highlighted fields.', {
        smId: [
          `The roster carries ${input.smId} but places them under no team leader. Fix the placement on Hierarchy, then create the account.`,
        ],
      });
    }
    return null;
  }

  // A manager's code is not a column of its own — a TL exists as the `tl_id` on
  // their reps' rows — so "does this code exist" is "does anybody report to it".
  const code = input.role === 'tl' ? input.tlCode : input.role === 'acm' ? input.acmCode : null;
  if (!code) return null;

  const column = input.role === 'tl' ? manpower.tlId : manpower.ccmId;
  const [row] = await db
    .select({ smId: manpower.smId })
    .from(manpower)
    .where(eq(column, code))
    .limit(1);

  if (!row) {
    const field = input.role === 'tl' ? 'tlCode' : 'acmCode';
    const noun = input.role === 'tl' ? 'team leader' : 'area manager';
    return fail('Check the highlighted fields.', {
      [field]: [
        `No rep on the roster reports to ${code}, so this ${noun} would have nobody beneath them and no step would ever route here. Check the code against the Manpower sheet.`,
      ],
    });
  }

  return null;
}

/* ------------------------------------------------- bulk roster provisioning */

// No l/I/1 and no O/0: these are read off the screen and typed by hand exactly
// once, and a pair of glyphs nobody can tell apart comes back as "the account
// you made me does not work" with no stored password to check it against.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 16;

/**
 * `randomInt` rather than `randomBytes(n)[i] % alphabet.length`: 256 is not a
 * multiple of 57, so the modulo draws the first 28 symbols measurably more
 * often than the rest. `randomInt` rejects out-of-range draws instead.
 */
function generatePassword(): string {
  let password = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

export type ProvisionedAccount = {
  code: string;
  rung: RosterRung;
  email: string;
  /** Returned once, to the screen that asked for it. Stored nowhere. */
  password: string;
  name: string;
};

export type RosterProvisionOutcome = {
  created: ProvisionedAccount[];
  refused: Array<{ key: string; code: string; reason: string }>;
};

/** `rung:code`, the identity of one worklist row. A code can hold two rungs. */
function splitKey(key: string): { rung: RosterRung | null; code: string } {
  const separator = key.indexOf(':');
  if (separator < 0) return { rung: null, code: key.trim().toUpperCase() };
  const rung = key.slice(0, separator).trim().toLowerCase();
  const code = key.slice(separator + 1).trim().toUpperCase();
  return { rung: rung in RUNG_LABELS ? (rung as RosterRung) : null, code };
}

/**
 * Creates an account for each selected roster entry — reps, team leaders and
 * area managers alike.
 *
 * The role, the scoping column and the sign-in address all come from the RUNG
 * the Manpower sheet puts the person on, re-derived here rather than taken from
 * the request. A Server Action is a POST endpoint with a stable id, so a caller
 * can send any rung for any code; believing them would mint an area-manager
 * login for a rep, which reads every team in their cluster.
 *
 * Deliberately NOT one transaction: a failure at the twentieth account must
 * leave the first nineteen usable, because their passwords have already been
 * rendered and quite possibly copied. A rollback would turn every one of those
 * into a credential for an account that does not exist, recoverable only by a
 * rerun that mints different passwords for people already holding the old ones.
 *
 * Every refusal is named. A code that is silently dropped is indistinguishable
 * from one the caller forgot to select.
 */
export async function provisionRosterAccounts(
  actor: Actor,
  keys: string[],
): Promise<ActionResult<RosterProvisionOutcome>> {
  // Deduplicated: the same key twice would create one account and then refuse
  // itself for already holding one, which reads as a failure rather than as the
  // caller having ticked a box twice.
  const wanted = [...new Set(keys.map((value) => value.trim()).filter(Boolean))];
  if (wanted.length === 0) return fail('Select at least one person from the roster.');

  // The worklist as the server derives it, accounts included. Re-read rather
  // than trusted: the keys arriving can be any keys at all, including ones the
  // page never offered.
  const roster = new Map((await listRoster()).map((entry) => [rosterKey(entry), entry]));

  const outcome: RosterProvisionOutcome = { created: [], refused: [] };

  for (const key of wanted) {
    const { rung, code } = splitKey(key);

    // Checked before the pattern, because `111222-UN` fails that test too and
    // would otherwise be refused for its hyphen — a true statement that tells the
    // admin nothing about why this code is not a person.
    if (isPlaceholderCode(code)) {
      outcome.refused.push({ key, code, reason: PLACEHOLDER_REASON });
      continue;
    }

    // Not defensive duplication of the `user_sm_id_uppercase` CHECK, which would
    // accept a hyphen quite happily. This is the rule the /admin/users form
    // validates against: an account created here with a code that form rejects
    // is an account no administrator could ever edit again, because
    // `updateUserSchema` re-validates every code on each save.
    if (!SM_ID_PATTERN.test(code)) {
      outcome.refused.push({
        key,
        code,
        reason:
          'not 3–32 characters of A–Z0–9, so /admin/users could never edit the account again',
      });
      continue;
    }

    /**
     * The Manpower sheet is the gate — 2026-08-06 spec section 5.
     *
     * An account whose code the sheet does not place is a login whose mapping
     * requests skip their team leader and area manager entirely: approved by
     * strictly fewer people than the business asked for, with nothing on any
     * screen saying so. The cost is accepted — a genuinely new rep waits for an
     * up-to-date roster import, and stays listed on /admin/hierarchy while they
     * do, so the wait is visible rather than being a silently weaker approval
     * path nobody is looking for.
     */
    const entry = rung ? roster.get(`${rung}:${code}`) : undefined;
    if (!entry) {
      outcome.refused.push({
        key,
        code,
        reason:
          'the Manpower sheet does not place this code at that rung, so the account would have nobody above or below it — import an up-to-date sheet first',
      });
      continue;
    }

    if (entry.accountEmail) {
      // Skipped rather than reissued: a new password would lock out whoever
      // signed in with the previous one, and nothing here ever knew it.
      outcome.refused.push({ key, code, reason: `already has an account — ${entry.accountEmail}` });
      continue;
    }

    const email = emailForRosterEntry(entry.rung, entry.code);
    const name = entry.name?.trim() || entry.code;
    const password = generatePassword();

    try {
      // Exactly one scoping column, the one this role reads. Setting a second
      // would produce an account `updateUserSchema` refuses to save, which is an
      // account no administrator can ever edit again.
      const created = await createUserAccount({
        name,
        email,
        password,
        role: entry.rung,
        smId: entry.rung === 'sales' ? entry.code : null,
        tlCode: entry.rung === 'tl' ? entry.code : null,
        acmCode: entry.rung === 'acm' ? entry.code : null,
      });

      await writeAudit({
        actor,
        action: 'USER_CREATE',
        entityType: 'user',
        entityId: created.id,
        after: { name, email, role: entry.rung, code: entry.code },
        metadata: {
          via: 'admin-roster-bulk',
          rung: entry.rung,
          reports: entry.reports,
          // Constant, because only a code the sheet places reaches this line. It
          // is recorded anyway so these rows read identically to the ones
          // `createUser` writes, which is what lets the trail be queried on one
          // shape.
          roster: 'roster',
          needsRosterReview: false,
        },
      });

      outcome.created.push({ code: entry.code, rung: entry.rung, email, password, name });
    } catch (error) {
      // `createUserAccount` throws on a duplicate email, which here means the
      // derived address is already held by an account carrying a different code
      // or none. A rerun cannot fix a name collision, so it is named.
      outcome.refused.push({
        key,
        code,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return ok(outcome);
}

/* ------------------------------------------------------- roster housekeeping */

export type RosterRemovalOutcome = {
  removed: Array<{ code: string; rung: RosterRung; name: string | null; recordsLeft: number }>;
  refused: Array<{ key: string; code: string; reason: string }>;
};

/**
 * Deletes a worklist entry off the roster.
 *
 * The Manpower sheet carries rows that are not people — a channel, a partner, a
 * bucket for business nobody has claimed. `DIY` and `111222-UN` are recognised
 * by name and never listed, but the sheet grows new ones and the admin needs a
 * way to say "this is not somebody who signs in" without hand-editing a table.
 *
 * Three refusals, and each is a case where deleting the row would break
 * something the screen cannot show:
 *
 *   * somebody still reports to it — the delete would strand a whole team with
 *     no manager to route their corrections to. Move them on Hierarchy first.
 *   * an account already carries the code — the login would outlive its roster
 *     row and resolve to nobody. Remove the account first.
 *   * the sheet has no row of its own for the code — a manager who exists only
 *     as the `CCM_ID` on other people's rows has nothing here to delete, and
 *     saying so is better than reporting a no-op as a success.
 *
 * Records already imported under the code are LEFT ALONE, and how many were
 * left is recorded on the audit row. They become business nobody is on the
 * roster for, which is exactly what the code meant in the first place; deleting
 * them would destroy imported data to tidy a worklist.
 */
export async function removeRosterEntries(
  actor: Actor,
  keys: string[],
): Promise<ActionResult<RosterRemovalOutcome>> {
  const wanted = [...new Set(keys.map((value) => value.trim()).filter(Boolean))];
  if (wanted.length === 0) return fail('Select at least one roster entry.');

  const roster = new Map((await listRoster()).map((entry) => [rosterKey(entry), entry]));

  const outcome: RosterRemovalOutcome = { removed: [], refused: [] };

  for (const key of wanted) {
    const { rung, code } = splitKey(key);

    const entry = rung ? roster.get(`${rung}:${code}`) : undefined;
    if (!entry) {
      outcome.refused.push({ key, code, reason: 'no longer on the worklist' });
      continue;
    }

    if (entry.reports > 0) {
      outcome.refused.push({
        key,
        code,
        reason: `${entry.reports} ${entry.reports === 1 ? 'person reports' : 'people report'} to it — move them to another manager on Hierarchy first`,
      });
      continue;
    }

    if (entry.accountEmail) {
      outcome.refused.push({
        key,
        code,
        reason: `${entry.accountEmail} signs in with this code — remove that account first`,
      });
      continue;
    }

    const [sheetRow] = await db.select().from(manpower).where(eq(manpower.smId, code)).limit(1);
    if (!sheetRow) {
      outcome.refused.push({
        key,
        code,
        reason:
          'the sheet carries this code only on other people’s rows, so there is nothing here to delete — re-import a sheet that drops it',
      });
      continue;
    }

    const [records] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(salesRecord)
      .where(eq(salesRecord.smId, code));
    const recordsLeft = Number(records?.value ?? 0);

    await db.transaction(async (tx) => {
      // Written BEFORE the delete: afterwards there is no row to describe, and
      // this entry is the only remaining evidence the sheet ever carried it.
      await writeAudit(
        {
          actor,
          action: 'ROSTER_ENTRY_DELETE',
          entityType: 'manpower',
          entityId: code,
          before: {
            smId: sheetRow.smId,
            smName: sheetRow.smName,
            tlId: sheetRow.tlId,
            ccmId: sheetRow.ccmId,
            location: sheetRow.location,
          },
          after: null,
          metadata: { rung: entry.rung, recordsLeft },
        },
        tx,
      );

      // The override goes with it. A pinned reporting line for a code that is no
      // longer on the roster is a row nothing reads and nothing can clear, and
      // it would silently come back to life if a later import reintroduced the
      // code.
      await tx.delete(manpowerOverride).where(eq(manpowerOverride.smId, code));
      await tx.delete(manpower).where(eq(manpower.smId, code));
    });

    outcome.removed.push({ code, rung: entry.rung, name: entry.name, recordsLeft });
  }

  return ok(outcome);
}

export async function updateUser(actor: Actor, raw: unknown): Promise<ActionResult<void>> {
  const parsed = updateUserSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const input = parsed.data;

  const [before] = await db.select().from(user).where(eq(user.id, input.userId)).limit(1);
  if (!before) return fail('That account no longer exists.');

  /**
   * An admin cannot demote themselves.
   *
   * The system can reach a state with no usable administrator this way: the
   * first-admin CLI refuses to run once any user exists, so recovery would mean
   * editing the `user` table by hand. Changing somebody else's role is fine —
   * the point is that the person making the change keeps the ability to undo it.
   */
  if (actor.id === input.userId && input.role !== 'admin') {
    return fail('You cannot change your own role. Ask another administrator.');
  }

  const [after] = await db
    .update(user)
    .set({
      name: input.name,
      role: input.role,
      smId: input.smId,
      tlCode: input.tlCode,
      acmCode: input.acmCode,
      updatedAt: new Date(),
    })
    .where(eq(user.id, input.userId))
    .returning();

  await writeAudit({
    actor,
    action: 'USER_UPDATE',
    entityType: 'user',
    entityId: input.userId,
    before: snapshot(before),
    after: snapshot(after),
  });

  return ok();
}

export type BulkRemovalOutcome = {
  deleted: string[];
  /** Accounts that could not be deleted, and were deactivated instead. */
  deactivated: Array<{ email: string; reason: string }>;
  /** Accounts deleted over their own audit history, and how much went with them. */
  forced: Array<{ email: string; deletedAuditRows: number }>;
  skipped: Array<{ email: string; reason: string }>;
};

/**
 * Removes several accounts at once — the admin screen's bulk action.
 *
 * Deleting a user is not always possible, and the reason is deliberate rather
 * than an obstacle to work around: `audit_log.actor_id` is `ON DELETE RESTRICT`
 * because this system's whole purpose is an unbroken record of who changed what.
 * An account that has done anything auditable therefore CANNOT be deleted without
 * destroying that record, so it is deactivated instead — which is what the
 * spec's "users are never hard-deleted" rule has always said.
 *
 * The outcome groups are the point. Silently deactivating something the admin
 * asked to delete would be lying about what happened; failing the whole batch
 * because one account has history would make the button useless on any
 * deployment that has been running. So each account gets the strongest action
 * that is safe for it, and the screen reports every group.
 *
 * `force` is the way past the audit-log block, and it DOES destroy the entries
 * it removes: every row the account is the actor of is deleted, then the account
 * is. Nothing is kept — not `actor_email`, not `actor_role`, not what was done.
 * It exists because "deactivate instead" is not always an acceptable answer (a
 * duplicate account, one created by mistake, a contractor who must come off the
 * list for real), and the alternative to offering it here was a DELETE run by
 * hand against the database.
 *
 * What survives is the USER_DELETE_FORCED entry written first, whose actor is
 * the ADMIN: the snapshot of the account, and the number of entries the purge
 * took. Rows about this account that somebody else authored are left alone —
 * they are that person's history, not this one's.
 *
 * It is not a delete-anything switch. Every other reference to the account —
 * the corrections it submitted, the uploads it committed — still holds, and an
 * account those tables are holding is reported as skipped with the constraint
 * named, having been deactivated rather than left untouched.
 */
export async function removeUsers(
  actor: Actor,
  userIds: string[],
  options: { force?: boolean } = {},
): Promise<ActionResult<BulkRemovalOutcome>> {
  if (userIds.length === 0) return fail('Select at least one account.');

  const outcome: BulkRemovalOutcome = { deleted: [], deactivated: [], forced: [], skipped: [] };

  for (const id of userIds) {
    const [row] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!row) continue;

    // The actor's own account is refused before anything else. Deleting it
    // signs them out mid-batch and, if they were the last admin, leaves nobody
    // able to undo any of it — the first-admin CLI refuses to run once any user
    // exists, so recovery would mean editing the table by hand.
    if (row.id === actor.id) {
      outcome.skipped.push({ email: row.email, reason: 'This is your own account.' });
      continue;
    }

    const [{ count: auditRows }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.actorId, row.id));

    if (Number(auditRows) > 0 && !options.force) {
      if (row.isActive) {
        await db
          .update(user)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(user.id, row.id));
      }
      await writeAudit({
        actor,
        action: 'USER_DEACTIVATE',
        entityType: 'user',
        entityId: row.id,
        before: snapshot(row),
        after: { ...snapshot(row), isActive: false },
        metadata: { via: 'bulk', requestedDelete: true, auditRows: Number(auditRows) },
      });
      outcome.deactivated.push({
        email: row.email,
        reason: `has ${auditRows} audit entr${auditRows === 1 ? 'y' : 'ies'} that must survive`,
      });
      continue;
    }

    if (Number(auditRows) > 0) {
      /**
       * Purge, then delete, in one transaction.
       *
       * The order matters and so does the atomicity. The entry describing the
       * removal is written first — afterwards there is no row to describe — and
       * its actor is the ADMIN, so it is not among the rows purged on the next
       * line and survives to be the record of what happened. If the delete then
       * fails on some other reference, the whole thing rolls back rather than
       * leaving a trail already destroyed for an account which is still there.
       */
      try {
        await db.transaction(async (tx) => {
          await writeAudit(
            {
              actor,
              action: 'USER_DELETE_FORCED',
              entityType: 'user',
              entityId: row.id,
              before: snapshot(row),
              after: null,
              metadata: { deletedAuditRows: Number(auditRows) },
            },
            tx,
          );

          // The one thing that unlocks a DELETE on `audit_log`, and it unlocks it
          // for this actor's rows only. `true` is set_config's is_local: the
          // setting is discarded at commit or rollback, so the pooled connection
          // cannot carry the permission to whoever gets it next.
          await tx.execute(sql`select set_config('app.purge_actor', ${row.id}, true)`);
          await tx.delete(auditLog).where(eq(auditLog.actorId, row.id));
          await tx.delete(user).where(eq(user.id, row.id));
        });
      } catch (error) {
        // 23503: something other than the audit log still references this
        // account — a correction it submitted, an upload it committed. Those
        // rows are work, not history, and deleting them is not on offer, so the
        // account is deactivated and the constraint is named. A generic failure
        // here would leave the admin with no idea which table to look at.
        const failure = pgError(error);
        if (failure?.code !== '23503') throw error;

        const constraint = failure.constraint;
        if (row.isActive) {
          await db
            .update(user)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(user.id, row.id));
        }
        outcome.skipped.push({
          email: row.email,
          reason:
            `still referenced by work it did${constraint ? ` (${constraint})` : ''}, ` +
            'so it was deactivated instead. That reference is not removable.',
        });
        continue;
      }

      outcome.forced.push({ email: row.email, deletedAuditRows: Number(auditRows) });
      continue;
    }

    // Written BEFORE the delete: afterwards there is no row to describe, and
    // this entry is the only remaining evidence the account ever existed. The
    // audit actor is the admin, never the deleted user, so the RESTRICT
    // constraint above cannot be tripped by the row we are about to write.
    await writeAudit({
      actor,
      action: 'USER_DEACTIVATE',
      entityType: 'user',
      entityId: row.id,
      before: snapshot(row),
      after: null,
      metadata: { via: 'bulk', deleted: true },
    });

    await db.delete(user).where(eq(user.id, row.id));
    outcome.deleted.push(row.email);
  }

  return ok(outcome);
}

export async function setUserActive(
  actor: Actor,
  userId: string,
  isActive: boolean,
): Promise<ActionResult<void>> {
  /**
   * An admin must not be able to deactivate their own account.
   *
   * Sessions are checked against `is_active` on every request (section 4.3), so
   * the click would sign them out mid-action and leave them unable to sign back
   * in to undo it. If they were the only active admin, nobody could: there is no
   * public sign-up and `setup:admin` refuses to run once any user exists, so the
   * only remedy left is an UPDATE run by hand against the database.
   */
  if (actor.id === userId && !isActive) {
    return fail('You cannot deactivate your own account. Ask another administrator.');
  }

  const [before] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!before) return fail('That account no longer exists.');

  if (before.isActive === isActive) return ok();

  const [after] = await db
    .update(user)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning();

  // Reactivation is an update, not an un-deactivation: USER_DEACTIVATE reads as
  // an event that happened, and using it for the reverse would make the trail
  // lie about which direction the account moved.
  await writeAudit({
    actor,
    action: isActive ? 'USER_UPDATE' : 'USER_DEACTIVATE',
    entityType: 'user',
    entityId: userId,
    before: snapshot(before),
    after: snapshot(after),
    metadata: { field: 'isActive' },
  });

  return ok();
}
