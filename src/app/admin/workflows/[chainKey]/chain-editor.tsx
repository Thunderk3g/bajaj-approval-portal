'use client';

import { useState, useTransition } from 'react';
import { saveChainStagesAction, type SaveChainInput } from '@/lib/workflows/actions';
import { Alert, Badge, Button, Field, Select, buttonClass } from '@/components/ui';

/**
 * Reordering, adding and removing the steps of one approval chain.
 *
 * Drag and drop is the native HTML5 API, not a library. The whole interaction is
 * five event handlers over a list this codebase will never render more than a
 * dozen rows of, and a drag-and-drop dependency would be the largest thing in the
 * bundle for the least-used screen in the product.
 *
 * Because dragging is unusable by keyboard and invisible to a screen reader, each
 * row also carries move-up / move-down buttons that do exactly the same thing.
 * They are not a fallback — they are the accessible path, and dragging is the
 * shortcut on top of it.
 */

/**
 * `canReject` is deliberately absent.
 *
 * It is not the admin's to set: the last step is the one that applies the change
 * and therefore the only one whose refusal ends the matter, so it is derived from
 * position on save. Carrying it in client state would be a field the form shows
 * nobody, writes nowhere, and overwrites anyway.
 */
export type EditableStage = {
  stageKey: string;
  resolverKey: string;
  resolverConfig: Record<string, unknown>;
};

export type ResolverOption = {
  /**
   * Identity of the OPTION, not of the resolver.
   *
   * Six of the seven options resolve through `'ROLE'` — V1 through V5 and the
   * approver all differ only by their config — so keying the dropdown on
   * `resolverKey` made every one of them the same value: picking "Approver"
   * added a V1, and every approver row rendered the V1 hint. The two ids are
   * separate because they answer different questions.
   */
  id: string;
  /** What the engine dispatches on. */
  resolverKey: string;
  label: string;
  /** Shown under the option so an admin picks by meaning, not by identifier. */
  hint: string;
  /** Whether this resolver needs to be told which side of a mapping it applies to. */
  needsSide: boolean;
  /** Whether this step is filled by a named person the admin picks. */
  needsAssignee?: boolean;
  /** Fixed config merged into every stage using this option. */
  baseConfig?: Record<string, unknown>;
};

export type AssignableUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  /** The code that says which team or location they manage, for telling two apart. */
  scope: string | null;
};

/**
 * Which option a saved stage came from.
 *
 * Matched on the config as well as the resolver key, because that is the only
 * thing that tells a V2 from an approver once both are stored as `'ROLE'`.
 */
function optionFor(
  stage: EditableStage,
  resolvers: ResolverOption[],
): ResolverOption | undefined {
  return (
    resolvers.find(
      (r) =>
        r.resolverKey === stage.resolverKey &&
        Object.entries(r.baseConfig ?? {}).every(
          ([key, value]) => stage.resolverConfig?.[key] === value,
        ),
    ) ?? resolvers.find((r) => r.resolverKey === stage.resolverKey)
  );
}

export function ChainEditor({
  chainKey,
  initial,
  resolvers,
  assignable,
}: {
  chainKey: string;
  initial: EditableStage[];
  resolvers: ResolverOption[];
  assignable: AssignableUser[];
}) {
  const [stages, setStages] = useState<EditableStage[]>(initial);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = JSON.stringify(stages) !== JSON.stringify(initial);

  function move(from: number, to: number) {
    if (to < 0 || to >= stages.length || from === to) return;
    const next = [...stages];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setStages(next);
    setSaved(false);
  }

  function remove(index: number) {
    if (stages.length === 1) {
      // Refused here as well as on the server. A chain with no steps accepts a
      // submission and then has nobody to review it, which is worse than the
      // button doing nothing.
      setError('A chain must keep at least one step — otherwise nothing would review these requests.');
      return;
    }
    setStages(stages.filter((_, i) => i !== index));
    setError(null);
    setSaved(false);
  }

  function add(optionId: string) {
    const option = resolvers.find((r) => r.id === optionId);
    if (!option) return;

    setStages([
      ...stages,
      {
        stageKey: suggestName(option, stages),
        resolverKey: option.resolverKey,
        resolverConfig: {
          ...(option.baseConfig ?? {}),
          ...(option.needsSide ? { smSide: 'SUBMITTER' } : {}),
        },
      },
    ]);
    setSaved(false);
  }

  function patch(index: number, change: Partial<EditableStage>) {
    setStages(stages.map((s, i) => (i === index ? { ...s, ...change } : s)));
    setSaved(false);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const payload: SaveChainInput = {
        chainKey: chainKey as SaveChainInput['chainKey'],
        // The LAST step is the one that applies the change, so it is the one that
        // must also be able to refuse outright. Enforced on save rather than left
        // to the admin, because a chain whose final step cannot reject can only
        // ever say yes.
        stages: stages.map((s, i) => ({ ...s, canReject: i === stages.length - 1 })),
      };

      const result = await saveChainStagesAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <div className="space-y-5">
      <ol className="space-y-2">
        {stages.map((stage, index) => {
          const option = optionFor(stage, resolvers);
          const isLast = index === stages.length - 1;

          return (
            <li
              key={`${stage.stageKey}-${index}`}
              draggable
              onDragStart={() => setDragging(index)}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(event) => {
                // Without preventDefault the browser refuses the drop outright —
                // the default for most elements is "not a drop target".
                event.preventDefault();
                setOver(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) move(dragging, index);
                setDragging(null);
                setOver(null);
              }}
              className={[
                'flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3 transition',
                dragging === index ? 'opacity-40' : '',
                over === index && dragging !== index ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200',
              ].join(' ')}
            >
              <span
                aria-hidden
                className="cursor-grab select-none px-1 text-lg leading-none text-slate-400"
                title="Drag to reorder"
              >
                ⠿
              </span>

              <span className="w-6 text-sm font-medium text-slate-500">{index + 1}</span>

              <input
                aria-label={`Name of step ${index + 1}`}
                className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={stage.stageKey}
                onChange={(event) => patch(index, { stageKey: event.target.value })}
              />

              <div className="flex-1 text-xs text-slate-600">
                {option?.hint ?? stage.resolverKey}
              </div>

              {option?.needsSide ? (
                <select
                  aria-label={`Which side step ${index + 1} applies to`}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                  value={String(stage.resolverConfig.smSide ?? 'SUBMITTER')}
                  onChange={(event) =>
                    patch(index, {
                      resolverConfig: { ...stage.resolverConfig, smSide: event.target.value },
                    })
                  }
                >
                  <option value="SUBMITTER">the submitter&apos;s team</option>
                  <option value="COUNTERPARTY">the other team</option>
                </select>
              ) : null}

              {/*
                Who fills this review position. Unassigned is allowed and is not
                an error — a chain can be laid out before the people are decided —
                but it is called out in amber, because a step with nobody on it
                falls through to the administrators at run time.
              */}
              {option?.needsAssignee ? (
                <select
                  aria-label={`Who decides step ${index + 1}`}
                  className={[
                    'rounded-md border px-2 py-1 text-xs',
                    stage.resolverConfig.userId
                      ? 'border-slate-300'
                      : 'border-amber-400 bg-amber-50 text-amber-900',
                  ].join(' ')}
                  value={String(stage.resolverConfig.userId ?? '')}
                  onChange={(event) =>
                    patch(index, {
                      resolverConfig: {
                        ...stage.resolverConfig,
                        userId: event.target.value || undefined,
                      },
                    })
                  }
                >
                  <option value="">— nobody assigned —</option>
                  {assignable.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} ({person.role}
                      {person.scope ? ` ${person.scope}` : ''})
                    </option>
                  ))}
                </select>
              ) : null}

              {isLast ? <Badge tone="info">applies the change · may reject</Badge> : null}

              <div className="flex gap-1">
                <button
                  type="button"
                  className={buttonClass('ghost', 'px-2 py-1 text-xs')}
                  onClick={() => move(index, index - 1)}
                  disabled={index === 0}
                  aria-label={`Move step ${index + 1} earlier`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'px-2 py-1 text-xs')}
                  onClick={() => move(index, index + 1)}
                  disabled={isLast}
                  aria-label={`Move step ${index + 1} later`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'px-2 py-1 text-xs text-red-600')}
                  onClick={() => remove(index)}
                  aria-label={`Remove step ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <Field label="Add a step" htmlFor="add-stage" hint="It joins the end of the chain; drag it where it belongs.">
        <div className="flex gap-2">
          <Select id="add-stage" defaultValue="" onChange={(event) => { add(event.target.value); event.currentTarget.value = ''; }}>
            <option value="" disabled>
              Choose who decides it…
            </option>
            {resolvers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved && !dirty ? <Alert tone="success">Saved. New requests will follow this chain.</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={pending || !dirty}>
          {pending ? 'Saving…' : 'Save chain'}
        </Button>
        {dirty ? (
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setStages(initial);
              setError(null);
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A name that does not collide with a step already in the chain. */
function suggestName(option: ResolverOption, stages: EditableStage[]): string {
  const base = option.label.replace(/\s*\(.*\)$/, '');
  if (!stages.some((s) => s.stageKey === base)) return base;

  for (let n = 2; n < 99; n += 1) {
    const candidate = `${base} ${n}`;
    if (!stages.some((s) => s.stageKey === candidate)) return candidate;
  }
  return base;
}
