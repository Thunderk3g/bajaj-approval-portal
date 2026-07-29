import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Card, LinkButton, PageHeader } from '@/components/ui';
import { RecordDetail } from '@/components/records/record-detail';
import { VersionHistory } from '@/components/records/version-history';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { getRecord } from '@/lib/records/query';
import { listRecordVersions } from '@/lib/records/versions';

export const metadata: Metadata = {
  title: 'Record · Sales Data Review Portal',
};

export default async function SalesRecordDetailPage({
  params,
}: {
  params: Promise<{ appsNo: string }>;
}) {
  let viewer: SessionUser;
  try {
    viewer = await requireRole('sales');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const { appsNo } = await params;

  // getRecord composes scopedRecordCondition, so another rep's application
  // comes back null and is rendered as a 404 — deliberately indistinguishable
  // from an Apps_No that does not exist. A 403 would confirm the application is
  // real and belongs to somebody, which is the leak itself (section 4.1).
  const record = await getRecord(viewer, appsNo);
  if (!record) notFound();

  const versions = await listRecordVersions(viewer, appsNo);

  return (
    <section className="space-y-4">
      <PageHeader
        title={`Application ${record.appsNo}`}
        description={record.clientName ?? undefined}
        actions={
          <>
            {/*
              The whole point of the rep seeing a gap is being able to act on it.
              Pre-filling appsNo means the correction form opens against this
              exact record rather than making the rep retype a 10-digit
              identifier they are looking straight at.
            */}
            <LinkButton href={`/sales/requests/new?appsNo=${encodeURIComponent(record.appsNo)}`} variant="primary">
              Raise a correction
            </LinkButton>
            {/*
              A transfer starts from a record the rep is already looking at —
              2026-07-29 spec section 4.1 — so this is where it belongs. Reaching
              it through the generic button would mean choosing the category and
              then the direction from a screen that has forgotten which record
              prompted it.
            */}
            <LinkButton
              href={`/sales/requests/new?appsNo=${encodeURIComponent(record.appsNo)}&category=MAPPING&direction=TRANSFER_OUT`}
            >
              Transfer to another SM
            </LinkButton>
            <LinkButton href="/sales/records">Back to my records</LinkButton>
          </>
        }
      />

      <RecordDetail record={record} />

      <Card
        title="Version history"
        description="Every change to this record, newest first, each diffed against the version before it."
      >
        <VersionHistory versions={versions} />
      </Card>
    </section>
  );
}
