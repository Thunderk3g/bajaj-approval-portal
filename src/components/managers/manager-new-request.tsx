import { Alert, PageHeader } from '@/components/ui';
import { NewCorrectionForm } from '@/components/corrections/new-correction-form';
import type { Role, SessionUser } from '@/lib/auth/rbac';
import { actorBooks } from '@/lib/corrections/service';
import {
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  ISSUED_DATE_MIN,
  MAPPING_DIRECTIONS,
  type MappingDirection,
  OTHERS_FIELD_CHOICES,
  issuedDateMax,
} from '@/lib/corrections/schemas';
import { listTeam } from '@/lib/managers/queries';
import { fieldLabel } from '@/lib/fields';
import { ACCEPT_ATTRIBUTE, MAX_PROOF_BYTES, MAX_PROOFS_PER_REQUEST } from '@/lib/storage/files';

/**
 * A manager raising a request on behalf of one of their people — spec section 5.
 *
 * The same form a rep uses, with two differences that both come from the same
 * fact: the manager is not the rep. A mapping claim has to NAME which of their
 * people the sale lands on, and a created request lives under this manager's own
 * routes rather than under /sales.
 *
 * Everything else is identical on purpose. The categories, the proof rules and
 * the field registry are the rep's, because "all kinds of request" means exactly
 * the kinds a rep can raise — a manager gains reach across their team, not a
 * second, wider vocabulary.
 *
 * `actorBooks` is the same function the submit path authorizes with, so the reps
 * this screen offers and the reps the server will accept cannot drift apart.
 */

const WORDS: Record<Role, { scope: string }> = {
  tl: { scope: 'your team' },
  acm: { scope: 'your cluster' },
  admin: { scope: '' },
  sales: { scope: '' },
  approver: { scope: '' },
  verifier: { scope: '' },
};

const CATEGORY_HINTS: Record<string, string> = {
  AUTOPAY: 'Confirm whether the AutoPay mandate is registered for this application.',
  MAPPING:
    'Move a sale between reps — either one credited elsewhere that belongs to one of your people, or one in their book that belongs to somebody else. Choose the direction below.',
  ISSUANCE_DATE: 'Correct the date the policy was issued.',
  AGENT_ID:
    'Correct the agent credited with this sale. This changes the Agent ID only — it does not move the sale between reps. Use Mapping for that.',
  OTHERS: 'Anything else — name the field and say what is wrong.',
};

export async function ManagerNewRequest({
  user,
  role,
  initialAppsNo = '',
  initialCategory,
  initialDirection,
}: {
  user: SessionUser;
  role: Role;
  initialAppsNo?: string;
  initialCategory?: string;
  initialDirection?: MappingDirection;
}) {
  const books = await actorBooks(user);
  const category = (CORRECTION_CATEGORIES as readonly string[]).includes(initialCategory ?? '')
    ? (initialCategory as string)
    : 'AUTOPAY';
  const direction = (MAPPING_DIRECTIONS as readonly string[]).includes(initialDirection ?? '')
    ? (initialDirection as MappingDirection)
    : 'CLAIM_IN';

  return (
    <section>
      <PageHeader
        title="New correction request"
        description={`Raised by you, on behalf of a rep in ${WORDS[role].scope}. The request belongs to their book and travels the same chain as one they raised themselves — which means it still reaches you for approval.`}
      />

      {books.ok ? null : (
        <div className="mb-4">
          <Alert tone="danger" title="There is nobody to raise a request for">
            {books.message}
          </Alert>
        </div>
      )}

      {books.ok ? (
        <NewCorrectionForm
          // Empty on purpose: a manager has no book of their own, and every
          // destination this form offers comes from the team list below.
          smId=""
          reps={await teamOptions(user)}
          requestBase={`/${role}/requests`}
          initialAppsNo={initialAppsNo}
          initialCategory={category}
          initialDirection={direction}
          categories={CORRECTION_CATEGORIES.map((value) => ({
            value,
            label: CATEGORY_LABELS[value],
            hint: CATEGORY_HINTS[value] ?? '',
          }))}
          fieldChoices={OTHERS_FIELD_CHOICES.map((value) => ({ value, label: fieldLabel(value) }))}
          accept={ACCEPT_ATTRIBUTE}
          maxFiles={MAX_PROOFS_PER_REQUEST}
          maxFileMb={MAX_PROOF_BYTES / (1024 * 1024)}
          issuedDateMin={ISSUED_DATE_MIN}
          issuedDateMax={issuedDateMax()}
        />
      ) : null}
    </section>
  );
}

/** The team, as the claim destination picker wants it. */
async function teamOptions(user: SessionUser): Promise<Array<{ smId: string; smName: string | null }>> {
  const team = await listTeam(user);
  return team.map((member) => ({ smId: member.smId, smName: member.smName }));
}
