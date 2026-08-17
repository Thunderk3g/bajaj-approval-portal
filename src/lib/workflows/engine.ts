import { and, asc, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionEvent,
  correctionRequest,
  correctionRequestStage,
  salesRecord,
  user as userTable,
} from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import {
  notifyMany,
  requestRecipients,
  type NotificationInput,
} from '@/lib/notifications/service';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/approvals/schemas';
import {
  applyCorrectionToRecord,
  notifySubmitterOfApproval,
  type DecisionActor,
} from '@/lib/approvals/record-apply';
import { getChain, type ChainKey } from './chains';
import { WorkflowError } from './errors';
import {
  activeUserIdsWithRole,
  resolveStageAuthorization,
  type StageAuthorization,
  type StageContext,
} from './resolvers';

/**
 * The N-stage state machine — 2026-08-06 spec section 4.
 *
 * One generic transition replaces the four hardcoded ones (verify, return-from-
 * verification, approve, reject/return). What each rung MEANS is a row in
 * `approval_chain_stage`; what happens when somebody decides one is here, and is
 * the same regardless of how many rungs there are or who they resolve to.
 */

type StageRow = typeof correctionRequestStage.$inferSelect;

/* ------------------------------------------------------------ materialising */

/**
 * Copies a chain's stages onto a request, and opens stage 0.
 *
 * The copy is the point. From here the request never reads `approval_chain_stage`
 * again, so an admin editing the chain tomorrow cannot change the rungs this
 * request still has to climb, add one it has already passed, or remove the one it
 * is sitting on. Snapshotting is the same discipline `period_id` already follows.
 */
export type StageNotice = {
  /** Who raised it, so the first rung reads "New … from Priya" as it always has. */
  actorName: string;
  resubmission: boolean;
};

export async function materializeStages(
  tx: DbTransaction,
  requestId: string,
  chainKey: ChainKey,
  notice?: StageNotice,
): Promise<{ stageCount: number; notified: number; warnings: string[] }> {
  const chain = await getChain(chainKey, tx);

  if (!chain) {
    throw new WorkflowError(
      'NO_CHAIN',
      `No approval chain is configured for ${chainKey}. An administrator must set one up before these requests can be raised.`,
    );
  }
  if (!chain.isActive) {
    throw new WorkflowError(
      'NO_CHAIN',
      `The approval chain for ${chainKey} is switched off, so new requests of this kind cannot be raised.`,
    );
  }
  if (chain.stages.length === 0) {
    throw new WorkflowError(
      'EMPTY_CHAIN',
      `The approval chain for ${chainKey} has no stages, so nothing would review this request.`,
    );
  }

  const rows = await tx
    .insert(correctionRequestStage)
    .values(
      chain.stages.map((stage, index) => ({
        requestId,
        sequence: index,
        stageKey: stage.stageKey,
        resolverKey: stage.resolverKey,
        resolverConfig: stage.resolverConfig,
        canReject: stage.canReject,
        // Every rung starts PENDING, including the first. `openStage` below is
        // what makes stage 0 ACTIVE, so the one code path that resolves an
        // assignee, pins it and notifies is also the one that opens the first
        // rung — a second, subtly different opener here is how the first stage
        // ends up the only one nobody was told about.
        status: 'PENDING' as const,
      })),
    )
    .returning();

  await tx
    .update(correctionRequest)
    .set({ chainKey, currentStageSequence: 0, totalStages: rows.length })
    .where(eq(correctionRequest.id, requestId));

  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  const opened = await openStage(tx, request, 0, notice);

  return { stageCount: rows.length, notified: opened.notified, warnings: opened.warnings };
}

/**
 * Sends a returned request back to the top of its OWN chain.
 *
 * Deliberately does not re-read `approval_chain`: a rep answering a question a
 * verifier asked should climb the same ladder they started on, not a longer one
 * an admin happened to configure while the request sat in their queue. Spec §9
 * open question 2 records this as the reversible default.
 */
export async function resetStages(
  tx: DbTransaction,
  requestId: string,
  notice?: StageNotice,
): Promise<{ notified: number; warnings: string[] }> {
  await tx
    .update(correctionRequestStage)
    .set({ status: 'PENDING', decidedBy: null, decidedAt: null, remarks: null, assignedUserId: null })
    .where(eq(correctionRequestStage.requestId, requestId));

  await tx
    .update(correctionRequest)
    .set({ currentStageSequence: 0 })
    .where(eq(correctionRequest.id, requestId));

  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  // Re-opened through the same path a first submission takes, so the rung is
  // re-resolved rather than reusing whoever it was pinned to last time. That
  // matters: between the return and the resubmission the rep may have been moved
  // to a different TL, and the stale assignee would be a queue entry for somebody
  // who no longer manages them.
  const opened = await openStage(tx, request, 0, notice);
  return { notified: opened.notified, warnings: opened.warnings };
}

/** Closes the open rung when the submitter withdraws, so no stage is left ACTIVE. */
export async function closeActiveStage(
  tx: DbTransaction,
  requestId: string,
  status: 'WITHDRAWN',
): Promise<void> {
  await tx
    .update(correctionRequestStage)
    .set({ status, decidedAt: new Date() })
    .where(
      and(
        eq(correctionRequestStage.requestId, requestId),
        eq(correctionRequestStage.status, 'ACTIVE'),
      ),
    );
}

/* ------------------------------------------------------------------ deciding */

export type StageDecision = 'ADVANCE' | 'RETURN' | 'REJECT';

export type DecideStageInput = {
  requestId: string;
  actor: DecisionActor;
  decision: StageDecision;
  remarks?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type DecideStageOutcome =
  | {
      kind: 'ADVANCED';
      requestId: string;
      appsNo: string;
      stageKey: string;
      nextStageKey: string;
      notified: number;
      warnings: string[];
    }
  | {
      kind: 'APPLIED';
      requestId: string;
      appsNo: string;
      stageKey: string;
      fieldName: string;
      fieldLabel: string;
      previousValue: string | null;
      newValue: string | null;
      appliedVersion: number;
      warnings: string[];
    }
  | { kind: 'RETURNED' | 'REJECTED'; requestId: string; appsNo: string; stageKey: string };

export async function decideStage(input: DecideStageInput): Promise<DecideStageOutcome> {
  return db.transaction((tx) => decideStageWithin(tx, input));
}

/**
 * Locks in a fixed order — record, then request, then stage.
 *
 * The order is the deadlock story. Every path that touches both rows takes the
 * record first, so two concurrent decisions against the same record queue rather
 * than each holding what the other wants. Two transactions that took the same
 * rows in opposite orders would eventually take each other's first lock and wait
 * forever; taking the record
 * first everywhere makes that impossible rather than unlikely.
 */
/**
 * Gives a request its stages if it has none, positioned where it already stands.
 *
 * Every request raised through `submitCorrection` is materialised at submission,
 * so this does nothing on the normal path. It exists for the two populations that
 * were never submitted through it: rows that predate this release, and rows a
 * caller inserted directly. Both are real — the first is every open request on
 * the day this ships, the second is most of the test suite — and both would
 * otherwise be undecidable, because the engine looks for an ACTIVE rung and finds
 * no rungs at all.
 *
 * Doing it here rather than as a one-off migration means the repair is idempotent
 * and cannot be half-applied: a request is fixed the moment somebody tries to act
 * on it, whether that is the day after the deploy or six weeks later.
 *
 * The position is read from the status the request already carries, so the repair
 * never moves work backwards or forwards:
 *
 *   PENDING   nobody has acted — the first rung is open.
 *   VERIFIED  under the two-stage flow this meant "past the verifier, with the
 *             approver", so the LAST rung is open and everything before it is
 *             marked passed. Anything else would hand the approver's work back to
 *             a verifier who had already done it.
 */
async function ensureStages(
  tx: DbTransaction,
  request: typeof correctionRequest.$inferSelect,
): Promise<void> {
  const existing = await tx
    .select({ id: correctionRequestStage.id, sequence: correctionRequestStage.sequence, status: correctionRequestStage.status })
    .from(correctionRequestStage)
    .where(eq(correctionRequestStage.requestId, request.id))
    .orderBy(asc(correctionRequestStage.sequence));

  if (existing.length > 0) {
    if (existing.some((s) => s.status === 'ACTIVE')) return;

    /**
     * Stages exist but none is open, while the request says it is still live.
     *
     * Reached when something moved `status` without going through the engine —
     * a resubmission written directly, a support fix, a caller that predates
     * this module. Left alone the request is undecidable forever: the engine
     * looks for an open rung, finds none, and reports it as already decided
     * while the status says otherwise.
     *
     * Re-opening the rung the status implies is the repair, and it is the same
     * rule the initial materialisation uses, so a request repaired this way is
     * indistinguishable from one that was never broken.
     */
    const target = request.status === 'VERIFIED' ? existing.length - 1 : 0;

    await tx
      .update(correctionRequestStage)
      .set({ status: 'PENDING', decidedBy: null, decidedAt: null, remarks: null, assignedUserId: null })
      .where(
        and(
          eq(correctionRequestStage.requestId, request.id),
          gte(correctionRequestStage.sequence, target),
        ),
      );

    await tx
      .update(correctionRequestStage)
      .set({ status: 'ACTIVE' })
      .where(
        and(
          eq(correctionRequestStage.requestId, request.id),
          eq(correctionRequestStage.sequence, target),
        ),
      );

    await tx
      .update(correctionRequest)
      .set({ currentStageSequence: target })
      .where(eq(correctionRequest.id, request.id));

    return;
  }

  // A row that predates `chain_key` gets the chain its category maps to. MAPPING
  // cannot be classified without re-deriving a counterparty the record may since
  // have lost, so it takes the DIY chain — the shortest of the three, and the one
  // that asks for no manager who was never involved.
  const chainKey =
    (request.chainKey as ChainKey | null) ??
    (request.category === 'MAPPING' ? 'MAPPING_DIY' : (request.category as ChainKey));

  const chain = await getChain(chainKey, tx);
  if (!chain || chain.stages.length === 0) {
    throw new WorkflowError(
      'NO_CHAIN',
      `This request has no approval steps and no chain is configured for ${chainKey}. An administrator must run the chain seed before it can be decided.`,
    );
  }

  const last = chain.stages.length - 1;
  const activeIndex = request.status === 'VERIFIED' ? last : 0;

  await tx.insert(correctionRequestStage).values(
    chain.stages.map((stage, index) => ({
      requestId: request.id,
      sequence: index,
      stageKey: stage.stageKey,
      resolverKey: stage.resolverKey,
      resolverConfig: stage.resolverConfig,
      canReject: stage.canReject,
      status:
        index < activeIndex
          ? ('PASSED' as const)
          : index === activeIndex
            ? ('ACTIVE' as const)
            : ('PENDING' as const),
      // Whoever cleared the first rung, where the old columns recorded it.
      decidedBy: index < activeIndex ? request.verifiedBy : null,
      decidedAt: index < activeIndex ? request.verifiedAt : null,
    })),
  );

  await tx
    .update(correctionRequest)
    .set({
      chainKey,
      currentStageSequence: activeIndex,
      totalStages: chain.stages.length,
    })
    .where(eq(correctionRequest.id, request.id));
}

async function lockForDecision(tx: DbTransaction, requestId: string) {
  const [head] = await tx
    .select({ recordId: correctionRequest.recordId })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!head) {
    throw new WorkflowError('NOT_FOUND', 'That correction request no longer exists.');
  }

  const [record] = await tx
    .select()
    .from(salesRecord)
    .where(eq(salesRecord.id, head.recordId))
    .limit(1)
    .for('update');

  const [locked] = await tx
    .select()
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1)
    .for('update');

  // Under the request lock, so two actors arriving at an unmaterialised request
  // together cannot both insert its stages and trip the one-active-rung index.
  // A terminal request is left alone — giving stages to something already decided
  // would reopen it.
  if (locked.status === 'PENDING' || locked.status === 'VERIFIED') {
    await ensureStages(tx, locked);
  }

  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  const [stage] = await tx
    .select()
    .from(correctionRequestStage)
    .where(
      and(
        eq(correctionRequestStage.requestId, requestId),
        eq(correctionRequestStage.status, 'ACTIVE'),
      ),
    )
    .limit(1)
    .for('update');

  if (!stage) {
    throw new WorkflowError('WRONG_STATUS', await noActiveStageMessage(tx, requestId));
  }

  return { request, record: record ?? null, stage };
}

async function noActiveStageMessage(tx: DbTransaction, requestId: string): Promise<string> {
  const [row] = await tx
    .select({ status: correctionRequest.status })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!row) return 'That correction request no longer exists.';
  if (row.status === 'RETURNED' || row.status === 'WITHDRAWN') {
    return `This request is ${row.status.toLowerCase()} and is back with the submitter.`;
  }
  return `This request is already ${row.status.toLowerCase()} and cannot be decided again.`;
}

/**
 * May this actor decide this stage?
 *
 * Re-checked here even though the queue only shows a stage to people who can act
 * on it. A Server Action is a POST endpoint reachable without rendering the page
 * that guards it, so an actor handed a request id — from a stale tab, a copied
 * link, or a crafted request — must be stopped here or not at all. This is the
 * generalised form of the `assertApprover` check the two-stage flow relied on,
 * and it is strictly tighter: a hierarchy stage narrows to one named person
 * rather than to everyone holding a role.
 */
async function assertMayDecide(
  tx: DbTransaction,
  stage: StageRow,
  auth: StageAuthorization,
  actor: DecisionActor,
  requestId: string,
): Promise<void> {
  if (auth.kind === 'UNRESOLVED') {
    // Nobody could be resolved for this rung, so it fell to the admins when it
    // opened (see `openStage`). Only they can clear it.
    if (actor.role !== 'admin') {
      throw new WorkflowError(
        'NOT_AUTHORIZED',
        `This step could not be routed to anyone (${auth.reason}) and is waiting on an administrator.`,
      );
    }
    return;
  }

  if (auth.kind === 'ROLE') {
    if (actor.role !== auth.role) {
      /**
       * Too early is a different answer from not allowed, and the difference is
       * the whole message.
       *
       * An approver handed a request still sitting with a verifier must be told
       * to WAIT. Saying "this step is decided by a verifier" describes the rung
       * correctly and leaves them looking for a mistake in their own permissions,
       * when the truth is that the request has not reached them yet.
       */
      const others = await tx
        .select({
          sequence: correctionRequestStage.sequence,
          status: correctionRequestStage.status,
          resolverConfig: correctionRequestStage.resolverConfig,
        })
        .from(correctionRequestStage)
        .where(
          and(
            eq(correctionRequestStage.requestId, requestId),
            ne(correctionRequestStage.sequence, stage.sequence),
          ),
        );

      const mine = others.filter((s) => s.resolverConfig?.role === actor.role);
      const comesLater = mine.some((s) => s.sequence > stage.sequence);
      // Somebody at this actor's own desk already dealt with it and it has moved
      // on. Distinct from "not yours": nothing is wrong, they are just looking at
      // a colleague's finished work.
      const alreadyDone = mine.some((s) => s.sequence < stage.sequence && s.status === 'PASSED');

      throw new WorkflowError(
        'NOT_AUTHORIZED',
        alreadyDone
          ? `Another ${actor.role} has already passed this request on to "${stage.stageKey}". Reload to see it.`
          : comesLater
            ? `This request has not been verified yet — it is at step "${stage.stageKey}" and has to clear that before it reaches you.`
            : `Step "${stage.stageKey}" is decided by ${article(auth.role)} ${auth.role}; ${actor.email} is ${article(actor.role)} ${actor.role}.`,
      );
    }
  } else if (!auth.userIds.includes(actor.id)) {
    throw new WorkflowError(
      'NOT_AUTHORIZED',
      `Step "${stage.stageKey}" is not yours to decide.`,
    );
  }

  /**
   * Separation of duties, where the chain asks for it.
   *
   * A chain like V1 → V2 exists to get two pairs of eyes on a request. Both rungs
   * resolve to "any active verifier", so without this the same person can clear
   * both and the second gate is decoration. Opt-in per stage rather than implied,
   * because a chain may legitimately want the same TL at two points.
   */
  if (stage.resolverConfig?.distinctActor === true) {
    const priors = await tx
      .select({ decidedBy: correctionRequestStage.decidedBy })
      .from(correctionRequestStage)
      .where(
        and(
          eq(correctionRequestStage.requestId, requestId),
          ne(correctionRequestStage.sequence, stage.sequence),
          inArray(correctionRequestStage.status, ['PASSED']),
        ),
      );

    if (priors.some((p) => p.decidedBy === actor.id)) {
      throw new WorkflowError(
        'NOT_AUTHORIZED',
        `You already signed off an earlier step on this request; step "${stage.stageKey}" needs a second reviewer.`,
      );
    }
  }
}

export async function decideStageWithin(
  tx: DbTransaction,
  input: DecideStageInput,
): Promise<DecideStageOutcome> {
  const remarks = input.remarks?.trim() || null;
  const { request, record, stage } = await lockForDecision(tx, input.requestId);

  const ctx: StageContext = {
    request,
    record,
    stage: {
      sequence: stage.sequence,
      stageKey: stage.stageKey,
      resolverKey: stage.resolverKey,
      resolverConfig: stage.resolverConfig,
    },
  };

  const auth = await resolveStageAuthorization(ctx, tx);
  await assertMayDecide(tx, stage, auth, input.actor, request.id);

  const isFinal = stage.sequence === request.totalStages - 1;
  const decidedAt = new Date();

  /* ---------------------------------------------------------- reject / return */

  if (input.decision === 'REJECT' || input.decision === 'RETURN') {
    if (!remarks) {
      throw new WorkflowError(
        'INVALID_VALUE',
        'Remarks are required so the submitter knows what to change.',
      );
    }
    if (input.decision === 'REJECT' && !stage.canReject) {
      throw new WorkflowError(
        'CANNOT_REJECT',
        `Step "${stage.stageKey}" can send a request back for more information, but only the final step can reject it outright.`,
      );
    }

    const status = input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';

    await tx
      .update(correctionRequestStage)
      .set({ status, decidedBy: input.actor.id, decidedAt, remarks })
      .where(eq(correctionRequestStage.id, stage.id));

    await tx
      .update(correctionRequest)
      .set({
        status,
        ...headlineColumns(stage, request.totalStages, input.actor.id, decidedAt, remarks),
      })
      .where(eq(correctionRequest.id, request.id));

    await tx.insert(correctionEvent).values({
      requestId: request.id,
      action: status,
      actorId: input.actor.id,
      fromStatus: request.status,
      toStatus: status,
      remarks,
      stageSequence: stage.sequence,
      stageKey: stage.stageKey,
    });

    await writeAudit(
      {
        actor: input.actor,
        /**
         * A return from an EARLIER rung is audited apart from one issued by the
         * final decider, and the distinction predates the chain: both write a
         * RETURNED status, so the status column cannot tell them apart
         * afterwards, and the separate action is what lets anyone ask how much
         * the review stages are sending back — the number that says whether a
         * gate is doing work or waving things through.
         *
         * Generalised from "verifier vs approver" to "before the final rung vs
         * at it", which is the same question once a chain can be five long.
         */
        action:
          input.decision === 'REJECT'
            ? 'CORRECTION_REJECT'
            : isFinal
              ? 'CORRECTION_RETURN'
              : 'CORRECTION_RETURN_VERIFIER',
        entityType: 'correction_request',
        entityId: request.id,
        before: { status: request.status, stage: stage.stageKey },
        after: { status, remarks },
        metadata: {
          appsNo: request.appsNo,
          category: request.category,
          fieldName: request.fieldName,
          submittedBy: request.submittedBy,
          stageKey: stage.stageKey,
          stageSequence: stage.sequence,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    // Both the submitter and the rep whose book it is, one row each. When a
    // manager raised it the rep would otherwise never learn it came back, and
    // the manager's link would point into /sales, which their role cannot open.
    const decided = await requestRecipients(request, tx);

    await notifyMany(
      decided.map((r) => ({
        userId: r.userId,
        // Same split as the audit action above: the rep is told which kind of
        // desk sent it back, because "the first reviewer wants more proof" and
        // "the final decider wants more proof" are different amounts of bad
        // news and the notification list is where they judge that.
        type:
          input.decision === 'REJECT'
            ? ('CORRECTION_REJECTED' as const)
            : isFinal
              ? ('CORRECTION_RETURNED' as const)
              : ('CORRECTION_RETURNED_BY_VERIFIER' as const),
        title:
          input.decision === 'REJECT'
            ? `Correction rejected — ${request.appsNo}`
            : `More information needed — ${request.appsNo}`,
        // A rep who did not raise it cannot answer the return, so the row says
        // so rather than leaving them looking for a form that is not there.
        body:
          r.isSubmitter || remarks === null
            ? remarks
            : `${remarks} — raised for your book by somebody else, so only they can answer it.`,
        link: r.link,
      })),
      tx,
    );

    return {
      kind: status,
      requestId: request.id,
      appsNo: request.appsNo,
      stageKey: stage.stageKey,
    };
  }

  /* ------------------------------------------------------------- advance */

  await tx
    .update(correctionRequestStage)
    .set({ status: 'PASSED', decidedBy: input.actor.id, decidedAt, remarks })
    .where(eq(correctionRequestStage.id, stage.id));

  if (isFinal) {
    if (!record) {
      throw new WorkflowError('NOT_FOUND', 'The record this request points at is gone.');
    }

    const applied = await applyCorrectionToRecord(tx, request, record, input.actor, input);

    await tx
      .update(correctionRequest)
      .set({
        status: 'APPROVED',
        reviewedBy: input.actor.id,
        reviewedAt: decidedAt,
        approverRemarks: remarks,
        appliedAt: decidedAt,
        appliedVersion: applied.appliedVersion,
      })
      .where(eq(correctionRequest.id, request.id));

    await tx.insert(correctionEvent).values({
      requestId: request.id,
      action: 'APPROVED',
      actorId: input.actor.id,
      fromStatus: request.status,
      toStatus: 'APPROVED',
      remarks,
      stageSequence: stage.sequence,
      stageKey: stage.stageKey,
    });

    await writeAudit(
      {
        actor: input.actor,
        action: 'CORRECTION_APPROVE',
        entityType: 'correction_request',
        entityId: request.id,
        before: { status: request.status, proposedValue: request.proposedValue },
        after: {
          status: 'APPROVED',
          appliedVersion: applied.appliedVersion,
          approverRemarks: remarks,
        },
        metadata: {
          appsNo: request.appsNo,
          category: request.category,
          fieldName: applied.fieldKey,
          submittedBy: request.submittedBy,
          stageKey: stage.stageKey,
          // Everyone who signed off on the way here. With N stages the single
          // `verifiedBy` column can only name one of them, and an audit reader
          // asking how a wrong value got through needs the whole chain.
          chainDecidedBy: await priorDeciders(tx, request.id),
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    await notifySubmitterOfApproval(tx, request, applied, remarks);

    return {
      kind: 'APPLIED',
      requestId: request.id,
      appsNo: request.appsNo,
      stageKey: stage.stageKey,
      fieldName: applied.fieldKey,
      fieldLabel: applied.label,
      previousValue: applied.previousValue,
      newValue: applied.newValue,
      appliedVersion: applied.appliedVersion,
      warnings: applied.warnings,
    };
  }

  /* not the last rung — open the next one */

  const next = await openStage(tx, request, stage.sequence + 1);

  await tx
    .update(correctionRequest)
    .set({
      status: 'VERIFIED',
      currentStageSequence: next.stage.sequence,
      ...headlineColumns(stage, request.totalStages, input.actor.id, decidedAt, remarks),
    })
    .where(eq(correctionRequest.id, request.id));

  /**
   * A verification is a verification at whatever rung it happens.
   *
   * This asked `stage.sequence === 0 && stage.resolverConfig?.role === 'verifier'`,
   * which is the two-rung world's definition and misses in both directions now:
   *
   *   - a SECOND verification step (`ISSUANCE_DATE` is V1 → V2 → APPROVER,
   *     `BAU_TO_BFL` is V3 → V4 → V5 → APPROVER) is not sequence 0, and
   *   - a step that names a verifier by user id rather than by role pool — which
   *     is how every seeded V-step is configured — carries no `role` in its
   *     config at all, so even the first rung failed the test.
   *
   * Both wrote ADVANCED, and the verifier's own history and weekly counter
   * filter on `action = 'VERIFIED'`, so a verifier could clear a step and see no
   * record of having done it.
   *
   * Keyed on the DECIDER's role instead of the stage's shape, which is the same
   * question `listVerifierHistory` already asks when it joins `actor.role =
   * 'verifier'` — one fact, asked once. Chains whose stage 0 is a verifier
   * produce exactly the rows they always did, so history and the timeline are
   * unchanged for everything that already worked.
   */
  await tx.insert(correctionEvent).values({
    requestId: request.id,
    action: input.actor.role === 'verifier' ? 'VERIFIED' : 'ADVANCED',
    actorId: input.actor.id,
    fromStatus: request.status,
    toStatus: 'VERIFIED',
    remarks,
    stageSequence: stage.sequence,
    stageKey: stage.stageKey,
  });

  await writeAudit(
    {
      actor: input.actor,
      action: input.actor.role === 'verifier' ? 'CORRECTION_VERIFY' : 'CORRECTION_ADVANCE',
      entityType: 'correction_request',
      entityId: request.id,
      before: { status: request.status, stage: stage.stageKey },
      after: { status: 'VERIFIED', stage: next.stage.stageKey, remarks },
      metadata: {
        appsNo: request.appsNo,
        category: request.category,
        fieldName: request.fieldName,
        submittedBy: request.submittedBy,
        stageKey: stage.stageKey,
        stageSequence: stage.sequence,
        nextStageKey: next.stage.stageKey,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  const categoryLabel = CATEGORY_LABELS[request.category as CorrectionCategory] ?? request.category;

  // The rep is told too. Without it, the only observable difference between
  // "waiting on one desk" and "waiting on the next" is a status word they would
  // have to go looking for.
  const advanced = await requestRecipients(request, tx);

  await notifyMany(
    advanced.map((r) => ({
      userId: r.userId,
      type: 'CORRECTION_VERIFIED' as const,
      title: `Progressed — ${request.appsNo}`,
      body: `${r.isSubmitter ? 'Your' : 'The'} ${categoryLabel.toLowerCase()} correction${
        r.isSubmitter ? '' : ' on your book'
      } cleared ${stage.stageKey} and is now with ${next.stage.stageKey}.`,
      link: r.link,
    })),
    tx,
  );

  return {
    kind: 'ADVANCED',
    requestId: request.id,
    appsNo: request.appsNo,
    stageKey: stage.stageKey,
    nextStageKey: next.stage.stageKey,
    notified: next.notified,
    warnings: next.warnings,
  };
}

/**
 * Opens a rung: marks it ACTIVE, pins who it resolved to, and tells them.
 *
 * Pinning `assignedUserId` here rather than re-resolving on every read is what
 * makes "my queue" a plain indexed lookup instead of running the resolver once
 * per open request — and it is also the correctness argument: a rep reassigned to
 * a new TL tomorrow must not silently move a request their old TL has already
 * opened and started reading.
 */
async function openStage(
  tx: DbTransaction,
  request: typeof correctionRequest.$inferSelect,
  sequence: number,
  notice?: StageNotice,
): Promise<{ stage: StageRow; notified: number; warnings: string[] }> {
  const warnings: string[] = [];

  const [record] = await tx
    .select({ id: salesRecord.id, smId: salesRecord.smId, appsNo: salesRecord.appsNo })
    .from(salesRecord)
    .where(eq(salesRecord.id, request.recordId))
    .limit(1);

  const [pending] = await tx
    .select()
    .from(correctionRequestStage)
    .where(
      and(
        eq(correctionRequestStage.requestId, request.id),
        eq(correctionRequestStage.sequence, sequence),
      ),
    )
    .limit(1);

  if (!pending) {
    throw new WorkflowError('NOT_FOUND', `This request has no step ${sequence}.`);
  }

  const auth = await resolveStageAuthorization(
    {
      request,
      record: record ?? null,
      stage: {
        sequence: pending.sequence,
        stageKey: pending.stageKey,
        resolverKey: pending.resolverKey,
        resolverConfig: pending.resolverConfig,
      },
    },
    tx,
  );

  let recipients: string[] = [];
  let assignedUserId: string | null = null;

  if (auth.kind === 'ROLE') {
    recipients = await activeUserIdsWithRole(auth.role, tx);
  } else if (auth.kind === 'USERS') {
    recipients = auth.userIds;
    // One named person is the assignee; a resolver returning several (a shared
    // rung, a deputy) leaves it unpinned and the queue matches on membership.
    assignedUserId = auth.userIds.length === 1 ? auth.userIds[0] : null;
  } else {
    /**
     * Nobody could be resolved — a roster gap, not a reason to stop.
     *
     * The actor who just advanced this request did legitimate work; refusing here
     * would roll their decision back over data they cannot fix. The rung opens,
     * the admins are told, and `assertMayDecide` lets only them clear it.
     */
    warnings.push(
      `Step "${pending.stageKey}" could not be routed to anyone: ${auth.reason} Administrators have been notified.`,
    );
    recipients = await activeUserIdsWithRole('admin', tx);
  }

  const [stage] = await tx
    .update(correctionRequestStage)
    .set({ status: 'ACTIVE', assignedUserId })
    .where(eq(correctionRequestStage.id, pending.id))
    .returning();

  if (recipients.length === 0) {
    warnings.push(
      `Nobody is currently able to act on step "${pending.stageKey}", so this request is waiting in a queue with no subscribers.`,
    );
  }

  const categoryLabel = CATEGORY_LABELS[request.category as CorrectionCategory] ?? request.category;

  /**
   * The first rung says who raised it; later rungs say which step it cleared.
   *
   * Preserved verbatim from the wording the two-stage flow used, because a
   * verifier scanning a list recognises "New AutoPay correction from Priya Nair"
   * and would have to open a generically-titled one to learn the same thing.
   */
  const title = notice
    ? `${notice.resubmission ? 'Resubmitted' : 'New'} ${categoryLabel} correction from ${notice.actorName}`
    : `${pending.stageKey}: ${categoryLabel} correction — ${request.appsNo}`;

  const roles = await rolesById(recipients, tx);

  const notifications: NotificationInput[] = recipients.map((userId) => ({
    userId,
    type: notice
      ? notice.resubmission
        ? ('CORRECTION_RESUBMITTED' as const)
        : ('CORRECTION_SUBMITTED' as const)
      : ('CORRECTION_VERIFIED' as const),
    title,
    body: `${request.fieldLabel} on application ${request.appsNo}: ${request.originalValue ?? '(blank)'} → ${request.proposedValue}`,
    link: stageLink(pending, request.id, roles.get(userId)),
  }));

  await notifyMany(notifications, tx);

  return { stage, notified: recipients.length, warnings };
}

/** "a verifier" but "an approver" / "an admin" — the roles start with both. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Where a notification about this rung should land the recipient.
 *
 * Derived from the rung, not from a fixed role: the same request is reviewed by a
 * verifier under `/verifier`, an approver under `/approver` and a manager under
 * their own space, and a link into somebody else's role prefix is bounced by the
 * guard on arrival — a notification the recipient cannot follow.
 */
function stageLink(stage: StageRow, requestId: string, recipientRole?: string | null): string {
  /**
   * The RECIPIENT's role decides the prefix, not the resolver's shape.
   *
   * Resolver shape was a good enough proxy while every named-person rung was a
   * manager and every pool rung was a verifier or an approver. It stopped being
   * one the moment a `USER` stage could name anybody: the shipped `MAPPING_DIY`,
   * `ISSUANCE_DATE` and `BAU_TO_BFL` chains all resolve their V-steps that way,
   * so a verifier named on one was sent a notification pointing at
   * `/admin/corrections/…` — a route only an administrator can open. They
   * followed the link to their own work and were bounced.
   *
   * Falling back to the resolver shape keeps every previously-correct link
   * identical, and the admin route remains the destination for a rung that
   * resolved to nobody, which is genuinely theirs to clear.
   */
  if (recipientRole === 'verifier') return `/verifier/requests/${requestId}`;
  if (recipientRole === 'approver') return `/approver/requests/${requestId}`;
  if (recipientRole === 'tl') return `/tl/requests/${requestId}`;
  if (recipientRole === 'acm') return `/acm/requests/${requestId}`;
  if (recipientRole === 'admin') return `/admin/corrections/${requestId}`;

  const role = stage.resolverKey === 'ROLE' ? stage.resolverConfig?.role : null;

  if (role === 'verifier') return `/verifier/requests/${requestId}`;
  if (role === 'approver') return `/approver/requests/${requestId}`;
  if (stage.resolverKey === 'TL_OF_SM') return `/tl/requests/${requestId}`;
  if (stage.resolverKey === 'ACM_OF_SM') return `/acm/requests/${requestId}`;
  // An unroutable rung falls to the admins, so it must link somewhere they can
  // actually reach.
  return `/admin/corrections/${requestId}`;
}

/**
 * The role of each user about to be notified, so their link lands in their own space.
 *
 * One query for the whole recipient list rather than one per notification: a
 * ROLE pool can be every approver in the company.
 */
async function rolesById(
  userIds: readonly string[],
  tx: DbTransaction,
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: userTable.id, role: userTable.role })
    .from(userTable)
    .where(inArray(userTable.id, [...userIds]));
  return new Map(rows.map((r) => [r.id, r.role as string]));
}

/**
 * Keeps the two legacy "headline" columns meaningful under N stages.
 *
 * `verified*` names whoever cleared the FIRST rung and `reviewed*` whoever
 * decided the LAST, which is exactly what they meant when there were only two.
 * Every dashboard, export column and query that already reads them keeps working
 * unchanged; the full per-rung detail lives in `correction_request_stage`.
 */
function headlineColumns(
  stage: StageRow,
  totalStages: number,
  actorId: string,
  at: Date,
  remarks: string | null,
): Partial<typeof correctionRequest.$inferInsert> {
  if (stage.sequence === 0) {
    return { verifiedBy: actorId, verifiedAt: at, verifierRemarks: remarks };
  }
  if (stage.sequence === totalStages - 1) {
    return { reviewedBy: actorId, reviewedAt: at, approverRemarks: remarks };
  }
  return {};
}

async function priorDeciders(tx: DbTransaction, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ stageKey: correctionRequestStage.stageKey, decidedBy: correctionRequestStage.decidedBy })
    .from(correctionRequestStage)
    .where(eq(correctionRequestStage.requestId, requestId))
    .orderBy(asc(correctionRequestStage.sequence));

  return rows.filter((r) => r.decidedBy).map((r) => `${r.stageKey}:${r.decidedBy}`);
}

/* -------------------------------------------------------------- my queue */

/**
 * "This request's open rung is mine" — as a predicate, for somebody else's WHERE.
 *
 * THE correction this module owes the rest of the app. Every queue screen was
 * written before the N-stage engine and asks `correction_request.status`
 * instead: the verifier's lists `PENDING`, the approver's lists `VERIFIED`. Those
 * were the only two states a request could hold when there were exactly two
 * rungs, and they stopped describing anything the moment a chain could be longer
 * — `advance` sets `VERIFIED` after ANY non-final rung passes, so it now means
 * "somewhere past the first gate" and nothing more.
 *
 * What that costs, concretely, with the chains this application ships:
 *
 *   ISSUANCE_DATE is V1 → V2 → APPROVER. A request the first verifier clears
 *   becomes VERIFIED with V2 open. The verifier's own queue files it under
 *   "with approvers, no longer yours" and hides the form; the approver's queue
 *   counts it as awaiting decision, offers the button, and `assertMayDecide`
 *   refuses the click. The rung that is actually open is offered by no screen in
 *   the product, so the request stops — and the only visible symptom is a queue
 *   depth that will not go down.
 *
 * The stage table has always known the answer. `decideStageWithin` authorizes
 * against exactly these three arms, so a queue built on this predicate offers a
 * decision if and only if the engine will accept it — the queue and the gate can
 * no longer disagree, because they are now the same statement asked twice.
 *
 * The third arm is the administrators' one. A hierarchy rung that resolved to
 * nobody — no roster placement, or a manager with no account — opens UNRESOLVED,
 * pins no user, and is decidable only by an admin (`assertMayDecide`). Until now
 * nothing listed those, so "the step falls to the administrators" meant it fell
 * out of the product entirely.
 */
export function actorStageCondition(actor: { id: string; role: string }): SQL {
  return sql`exists (
    select 1
      from correction_request_stage acs
     where acs.request_id = ${correctionRequest.id}
       and acs.status = 'ACTIVE'
       and (
         acs.assigned_user_id = ${actor.id}
         or (
           acs.assigned_user_id is null
           and acs.resolver_key = 'ROLE'
           and acs.resolver_config ->> 'role' = ${actor.role}
         )
         or (
           ${actor.role} = 'admin'
           and acs.assigned_user_id is null
           and acs.resolver_key <> 'ROLE'
         )
       )
  )`;
}

/**
 * The open rung of one request, and whether it is this actor's to decide.
 *
 * The single-request twin of `actorStageCondition`, so a detail screen decides
 * whether to render its decision form from the same fact the queue used to list
 * it — rather than from `status === 'PENDING'` (the verifier screen) or
 * `status === 'VERIFIED'` (the approver's), each of which is wrong for a chain
 * longer than two rungs in a different direction.
 */
export async function openStageFor(
  requestId: string,
  actor: { id: string; role: string },
): Promise<{ stageKey: string; sequence: number; isMine: boolean } | null> {
  const [row] = await db
    .select({
      stageKey: correctionRequestStage.stageKey,
      sequence: correctionRequestStage.sequence,
      assignedUserId: correctionRequestStage.assignedUserId,
      resolverKey: correctionRequestStage.resolverKey,
      resolverConfig: correctionRequestStage.resolverConfig,
    })
    .from(correctionRequestStage)
    .where(
      and(
        eq(correctionRequestStage.requestId, requestId),
        eq(correctionRequestStage.status, 'ACTIVE'),
      ),
    )
    .limit(1);

  if (!row) return null;

  const pooledRole = (row.resolverConfig as { role?: string } | null)?.role;
  const isMine =
    row.assignedUserId === actor.id ||
    (row.assignedUserId === null && row.resolverKey === 'ROLE' && pooledRole === actor.role) ||
    (row.assignedUserId === null && row.resolverKey !== 'ROLE' && actor.role === 'admin');

  return { stageKey: row.stageKey, sequence: row.sequence, isMine };
}

export type ActionableRow = {
  requestId: string;
  appsNo: string;
  category: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string | null;
  smId: string;
  stageKey: string;
  stageSequence: number;
  totalStages: number;
  submittedAt: Date;
};

/**
 * Every request currently waiting on this actor.
 *
 * One indexed query, not a resolver call per open request, and `assignedUserId`
 * is what makes that possible: a hierarchy rung records who it resolved to at the
 * moment it opened, so "waiting on me" is a column comparison rather than a
 * question only the hierarchy module can answer. Role-pool rungs pin nobody and
 * match on the actor's role instead.
 */
export async function listActionableForUser(actor: {
  id: string;
  role: string;
}): Promise<ActionableRow[]> {
  const rows = await db
    .select({
      requestId: correctionRequest.id,
      appsNo: correctionRequest.appsNo,
      category: correctionRequest.category,
      fieldLabel: correctionRequest.fieldLabel,
      originalValue: correctionRequest.originalValue,
      proposedValue: correctionRequest.proposedValue,
      smId: correctionRequest.smId,
      stageKey: correctionRequestStage.stageKey,
      stageSequence: correctionRequestStage.sequence,
      totalStages: correctionRequest.totalStages,
      submittedAt: correctionRequest.submittedAt,
    })
    .from(correctionRequestStage)
    .innerJoin(
      correctionRequest,
      eq(correctionRequest.id, correctionRequestStage.requestId),
    )
    .where(
      and(
        eq(correctionRequestStage.status, 'ACTIVE'),
        sql`(
          ${correctionRequestStage.assignedUserId} = ${actor.id}
          or (
            ${correctionRequestStage.assignedUserId} is null
            and ${correctionRequestStage.resolverKey} = 'ROLE'
            and ${correctionRequestStage.resolverConfig} ->> 'role' = ${actor.role}
          )
        )`,
      ),
    )
    .orderBy(asc(correctionRequest.submittedAt));

  return rows;
}

/* ------------------------------------------------------- routing a stuck rung */

export type RerouteOutcome = {
  requestId: string;
  appsNo: string;
  stageKey: string;
  routed: boolean;
  /** Why it still cannot be routed, when `routed` is false. */
  reason: string | null;
  notified: number;
};

/**
 * Re-resolves an open rung that resolved to nobody when it was opened.
 *
 * A request's stages are COPIED from the chain at submission and never re-read —
 * deliberately, and that rule stays: a chain edited mid-review must not silently
 * move a request somebody has already opened, and a rep reassigned to a new team
 * leader must not re-route a decision in flight.
 *
 * The rule has one hole, and it is the whole reason this function exists. A rung
 * that resolved to NOBODY froze nothing worth keeping. The seeded `MAPPING_DIY`,
 * `ISSUANCE_DATE`, `BAU_TO_BFL`, `OTHERS` and `AGENT_ID` chains all ship with
 * `USER` stages whose `resolver_config` is `{}` — no person configured — so every
 * request onto them opens ACTIVE, pinned to nobody, and stops. Naming a verifier
 * on the chain afterwards fixed the chain and did nothing for the requests
 * already stranded behind it: they stayed dangling with no way, anywhere in the
 * product, to get them moving again.
 *
 * So: only ever touches a rung that is ACTIVE **and** unresolved — no
 * `assigned_user_id`, and not a `ROLE` pool (a pool always has an answer, even if
 * the pool is currently empty). A rung that resolved to a real person is left
 * exactly alone, which is what preserves the freeze.
 *
 * Matched by `stage_key`, not by sequence: an admin who reordered the chain moved
 * the sequence numbers, and "V2" is the rung a human means. A chain that no
 * longer contains this rung at all is reported rather than repointed at whatever
 * now sits in that slot.
 */
export async function retryStageRouting(
  requestId: string,
  tx?: DbTransaction,
): Promise<RerouteOutcome | null> {
  const run = async (executor: DbTransaction): Promise<RerouteOutcome | null> => {
    const [request] = await executor
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, requestId))
      .limit(1);

    if (!request) return null;

    // FOR UPDATE, same as every other stage mutation: two admins clicking retry
    // on the same row would otherwise both resolve and both notify.
    const [stage] = await executor
      .select()
      .from(correctionRequestStage)
      .where(
        and(
          eq(correctionRequestStage.requestId, requestId),
          eq(correctionRequestStage.status, 'ACTIVE'),
        ),
      )
      .limit(1)
      .for('update');

    if (!stage) return null;

    const base = {
      requestId,
      appsNo: request.appsNo,
      stageKey: stage.stageKey,
      notified: 0,
    };

    if (stage.assignedUserId || stage.resolverKey === 'ROLE') {
      return { ...base, routed: true, reason: null, notified: 0 };
    }

    // Refresh this rung's resolver from the chain as it stands NOW. Without this
    // the re-resolution would just re-run the same empty config and fail again.
    const chain = request.chainKey ? await getChain(request.chainKey as ChainKey, executor) : null;
    const current = chain?.stages.find((s) => s.stageKey === stage.stageKey);

    if (!current) {
      return {
        ...base,
        routed: false,
        reason: `The ${chain ? chain.chainKey : 'original'} chain no longer has a step called "${stage.stageKey}", so there is nothing to re-read its routing from.`,
      };
    }

    const [refreshed] = await executor
      .update(correctionRequestStage)
      .set({ resolverKey: current.resolverKey, resolverConfig: current.resolverConfig })
      .where(eq(correctionRequestStage.id, stage.id))
      .returning();

    const [record] = await executor
      .select({ id: salesRecord.id, smId: salesRecord.smId, appsNo: salesRecord.appsNo })
      .from(salesRecord)
      .where(eq(salesRecord.id, request.recordId))
      .limit(1);

    const auth = await resolveStageAuthorization(
      {
        request,
        record: record ?? null,
        stage: {
          sequence: refreshed.sequence,
          stageKey: refreshed.stageKey,
          resolverKey: refreshed.resolverKey,
          resolverConfig: refreshed.resolverConfig,
        },
      },
      executor,
    );

    if (auth.kind === 'UNRESOLVED') {
      return { ...base, routed: false, reason: auth.reason };
    }

    const recipients =
      auth.kind === 'ROLE' ? await activeUserIdsWithRole(auth.role, executor) : auth.userIds;
    const assignedUserId =
      auth.kind === 'USERS' && auth.userIds.length === 1 ? auth.userIds[0] : null;

    await executor
      .update(correctionRequestStage)
      .set({ assignedUserId })
      .where(eq(correctionRequestStage.id, refreshed.id));

    // Told now, because they were never told when the rung opened — the original
    // notification went to the administrators as an unroutable step.
    const categoryLabel =
      CATEGORY_LABELS[request.category as CorrectionCategory] ?? request.category;

    const roles = await rolesById(recipients, executor);

    await notifyMany(
      recipients.map((userId) => ({
        userId,
        type: 'CORRECTION_VERIFIED' as const,
        title: `${refreshed.stageKey}: ${categoryLabel} correction — ${request.appsNo}`,
        body: `${request.fieldLabel} on application ${request.appsNo}: ${request.originalValue ?? '(blank)'} → ${request.proposedValue}. This step was waiting to be routed and is now yours.`,
        link: stageLink(refreshed, request.id, roles.get(userId)),
      })),
      executor,
    );

    return { ...base, routed: true, reason: null, notified: recipients.length };
  };

  return tx ? run(tx) : db.transaction(run);
}

/**
 * Every stranded rung on a given chain, re-resolved after the chain was edited.
 *
 * The admin-facing half of `retryStageRouting`: naming a verifier on a chain is
 * the moment the requests waiting on that chain become routable, so it is the
 * moment to route them. Failures are collected rather than thrown — a chain edit
 * must not be rolled back because one of the requests behind it is still
 * unroutable for an unrelated reason.
 */
export async function retryRoutingForChain(chainKey: ChainKey): Promise<RerouteOutcome[]> {
  const stranded = await db
    .select({ requestId: correctionRequestStage.requestId })
    .from(correctionRequestStage)
    .innerJoin(correctionRequest, eq(correctionRequest.id, correctionRequestStage.requestId))
    .where(
      and(
        eq(correctionRequestStage.status, 'ACTIVE'),
        sql`${correctionRequestStage.assignedUserId} is null`,
        ne(correctionRequestStage.resolverKey, 'ROLE'),
        eq(correctionRequest.chainKey, chainKey),
      ),
    );

  const outcomes: RerouteOutcome[] = [];
  for (const row of stranded) {
    const outcome = await retryStageRouting(row.requestId).catch(() => null);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}
