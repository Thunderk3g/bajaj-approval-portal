import { alias } from 'drizzle-orm/pg-core';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequestStage, user } from '@/db/schema';
import { Badge, Card, EmptyState, cx, type BadgeTone } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

/**
 * "Where it has got to" — every rung, who it waits on, and what they said.
 *
 * Lifted out of the manager screen so the verifier and the approver see the same
 * thing. All three now run the same N-stage chain, and a reviewer who cannot see
 * which rungs have already cleared is deciding without knowing whether anyone
 * has looked at this before them — the exact question the chain exists to answer.
 *
 * A Server Component with its own read, like the manager screen's version before
 * it: the stages are not part of `getRequestDetail`, and threading them through
 * three call sites to save one indexed query on `(request_id, sequence)` would
 * buy nothing.
 */

const assignee = alias(user, 'stage_assignee');
const decider = alias(user, 'stage_decider');

/** What kind of person a rung resolves to, in words rather than resolver keys. */
const RESOLVER_LABELS: Record<string, string> = {
  ROLE: 'role pool',
  USER: 'named person',
  TL_OF_SM: 'team leader',
  ACM_OF_SM: 'area manager',
};

/**
 * Stage status has its own vocabulary, deliberately not `StatusBadge`'s.
 *
 * That map reads PENDING as amber "waiting on someone", which is true of a
 * request and false of a rung: a rung is PENDING when the request has not
 * reached it yet, and colouring five untouched rungs amber would report a
 * healthy chain as five overdue steps.
 */
const STAGE_STATE: Record<string, { label: string; tone: BadgeTone; dot: string; glyph: string }> = {
  PENDING: {
    label: 'Not reached',
    tone: 'neutral',
    dot: 'border-slate-300 bg-white text-slate-400',
    glyph: '',
  },
  ACTIVE: {
    label: 'Waiting here',
    tone: 'warning',
    dot: 'border-slate-900 bg-slate-900 text-white',
    glyph: '',
  },
  PASSED: {
    label: 'Cleared',
    tone: 'success',
    dot: 'border-emerald-600 bg-emerald-600 text-white',
    glyph: '✓',
  },
  RETURNED: {
    label: 'Sent back',
    tone: 'info',
    dot: 'border-amber-500 bg-amber-500 text-white',
    glyph: '↩',
  },
  REJECTED: {
    label: 'Rejected here',
    tone: 'danger',
    dot: 'border-red-600 bg-red-600 text-white',
    glyph: '✕',
  },
  WITHDRAWN: {
    label: 'Withdrawn',
    tone: 'neutral',
    dot: 'border-slate-200 bg-slate-100 text-slate-400',
    glyph: '—',
  },
};

const FALLBACK = STAGE_STATE.PENDING;

export async function ChainProgress({ requestId }: { requestId: string }) {
  const stages = await db
    .select({
      id: correctionRequestStage.id,
      sequence: correctionRequestStage.sequence,
      stageKey: correctionRequestStage.stageKey,
      resolverKey: correctionRequestStage.resolverKey,
      resolverConfig: correctionRequestStage.resolverConfig,
      status: correctionRequestStage.status,
      decidedAt: correctionRequestStage.decidedAt,
      remarks: correctionRequestStage.remarks,
      assigneeName: assignee.name,
      deciderName: decider.name,
    })
    .from(correctionRequestStage)
    .leftJoin(assignee, eq(assignee.id, correctionRequestStage.assignedUserId))
    .leftJoin(decider, eq(decider.id, correctionRequestStage.decidedBy))
    .where(eq(correctionRequestStage.requestId, requestId))
    .orderBy(asc(correctionRequestStage.sequence));

  return (
    <Card title="Where it has got to" description="Every rung, who it waits on, and what they said.">
      {stages.length === 0 ? (
        <EmptyState
          title="This request has no chain recorded"
          description="It predates the configurable approval chain, so its progress lives in the timeline below instead."
        />
      ) : (
        <ol>
          {stages.map((stage, index) => {
            const state = STAGE_STATE[stage.status] ?? FALLBACK;
            const role =
              typeof stage.resolverConfig?.role === 'string' ? stage.resolverConfig.role : null;
            const kind = RESOLVER_LABELS[stage.resolverKey] ?? stage.resolverKey;

            // Who it waits on, in the tense the rung is actually in: a decided
            // rung names the person who decided it, an open one the person (or
            // the pool) it is sitting with.
            const who =
              stage.deciderName ??
              stage.assigneeName ??
              (role ? `Any ${role}` : 'Nobody resolved yet');

            return (
              <li key={stage.id} className="flex gap-3">
                <div className="flex shrink-0 flex-col items-center">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums',
                      state.dot,
                    )}
                  >
                    {state.glyph || stage.sequence + 1}
                  </span>
                  {index < stages.length - 1 ? (
                    <span className="w-px flex-1 bg-slate-200" aria-hidden="true" />
                  ) : null}
                </div>

                <div className={cx('min-w-0 flex-1', index < stages.length - 1 && 'pb-3.5')}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[13px] font-semibold text-slate-900">
                      {stage.stageKey}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-400">
                      {kind}
                    </span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>

                  <p className="mt-1 text-[13px] text-slate-800">{who}</p>

                  {stage.decidedAt ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {formatDateTime(stage.decidedAt)}
                    </p>
                  ) : null}

                  {stage.remarks ? (
                    <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-slate-200 pl-2 text-[12px] text-slate-600">
                      &ldquo;{stage.remarks}&rdquo;
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
