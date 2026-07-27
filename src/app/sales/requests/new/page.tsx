import type { Metadata } from 'next';
import {
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  ISSUED_DATE_MIN,
  OTHERS_FIELD_CHOICES,
  issuedDateMax,
} from '@/lib/corrections/schemas';
import { requireSalesActor } from '@/lib/corrections/session';
import { fieldLabel } from '@/lib/fields';
import {
  ACCEPT_ATTRIBUTE,
  MAX_PROOF_BYTES,
  MAX_PROOFS_PER_REQUEST,
} from '@/lib/storage/files';
import { NewCorrectionForm } from '@/components/corrections/new-correction-form';
import { Alert, PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'New correction request · Sales Data Review Portal',
};

const CATEGORY_HINTS: Record<string, string> = {
  AUTOPAY: 'Confirm whether the AutoPay mandate is registered for this application.',
  MAPPING:
    'Claim a sale that was credited to another rep. You can look up any application number to check it, and the approver decides.',
  ISSUANCE_DATE: 'Correct the date the policy was issued.',
  OTHERS: 'Anything else — name the field and say what is wrong.',
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireSalesActor();
  const params = await searchParams;

  const requestedCategory = first(params.category).toUpperCase();
  const initialCategory = (CORRECTION_CATEGORIES as readonly string[]).includes(requestedCategory)
    ? requestedCategory
    : 'AUTOPAY';

  return (
    <section>
      <PageHeader
        title="New correction request"
        description="Every request needs proof. The approver sees your proposed value beside the current one before deciding."
      />

      {actor.smId ? null : (
        <div className="mb-4">
          <Alert tone="danger" title="Your account has no SM ID">
            Ask an administrator to set one before raising a correction.
          </Alert>
        </div>
      )}

      <NewCorrectionForm
        smId={actor.smId ?? ''}
        initialAppsNo={first(params.appsNo)}
        initialCategory={initialCategory}
        categories={CORRECTION_CATEGORIES.map((value) => ({
          value,
          label: CATEGORY_LABELS[value],
          hint: CATEGORY_HINTS[value] ?? '',
        }))}
        // Resolved here rather than in the browser: the field registry is the
        // authority on which fields exist and what they are called, and it stays
        // on the server.
        fieldChoices={OTHERS_FIELD_CHOICES.map((value) => ({ value, label: fieldLabel(value) }))}
        accept={ACCEPT_ATTRIBUTE}
        maxFiles={MAX_PROOFS_PER_REQUEST}
        maxFileMb={MAX_PROOF_BYTES / (1024 * 1024)}
        issuedDateMin={ISSUED_DATE_MIN}
        issuedDateMax={issuedDateMax()}
      />
    </section>
  );
}
