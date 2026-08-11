import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { rosterState } from '@/lib/import/roster-gate';
import { Alert, Card, LinkButton, PageHeader } from '@/components/ui';
import { UploadForm } from '../_components/upload-form';
import { UploadSteps } from '../_components/upload-steps';

export const metadata: Metadata = {
  title: 'New upload · Sales Data Review Portal',
};

export default async function NewUploadPage() {
  await requireRoleOrRedirect('admin');
  const roster = await rosterState();

  return (
    // Capped rather than full-bleed: this screen is one file input, one textarea
    // and a paragraph the admin has to actually read. Run it to 1500px and the
    // warning above the form ends up a single line of amber nobody registers.
    <section className="max-w-[920px]">
      <PageHeader
        title="New upload"
        description="Six steps, all of them reversible until the last one. Uploading only stores and hashes the file."
        actions={<LinkButton href="/admin/uploads">Back to uploads</LinkButton>}
      />

      {/* The whole journey, before any of it has been committed to. The five
          steps after this one happen on the review screen, and an admin who can
          see them here does not have to discover halfway through that a roster
          commit was going to be asked of them. */}
      <UploadSteps
        className="mb-4"
        states={['current', 'todo', 'todo', 'todo', 'todo', 'todo']}
      />

      {/*
        Stated before the file is chosen, not after the commit fails. The order
        matters and it is not obvious: a business dashboard imported without a
        roster produces records that look perfect and corrections that silently
        skip two approval steps.
      */}
      {roster.ready ? (
        <Alert tone="success">
          The roster places <strong>{roster.placed}</strong> rep
          {roster.placed === 1 ? '' : 's'} under a team leader and area manager, so a business
          dashboard imported now will map its SM_IDs against them.
          {roster.orphans > 0 ? (
            <>
              {' '}
              <strong>{roster.orphans}</strong> further SM_ID
              {roster.orphans === 1 ? ' was' : 's were'} seen in transaction data but are not on the
              roster — see{' '}
              <Link className="underline" href="/admin/hierarchy">
                Hierarchy
              </Link>
              .
            </>
          ) : null}
        </Alert>
      ) : (
        <Alert tone="warning" title="Import a Manpower sheet first">
          <div className="space-y-2">
            <p>
              No roster exists yet. The Manpower sheet is the only thing that places a rep under a
              team leader and that team leader under an area manager — and it is the only source of
              accounts. Nothing creates users from a business dashboard.
            </p>
            <p>
              Upload either a workbook containing a <strong>Manpower</strong> sheet on its own, or
              the full dashboard workbook — as long as a Manpower sheet is in it, one pass does
              both. A transaction sheet with no roster anywhere is refused at commit.
            </p>
          </div>
        </Alert>
      )}

      <div className="mt-4">
        <Card title="1 · The file">
          <UploadForm />
        </Card>
      </div>
    </section>
  );
}
