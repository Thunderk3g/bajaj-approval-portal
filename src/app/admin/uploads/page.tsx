import type { Metadata } from 'next';
import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatch, user } from '@/db/schema';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { formatDateTime } from '@/lib/format';
import {
  EmptyState,
  LinkButton,
  PageHeader,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { DeleteUploadButton } from './_components/delete-upload-button';

export const metadata: Metadata = {
  title: 'Uploads · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

export default async function UploadsPage() {
  // The layout already gates /admin, but a page that reads batch metadata
  // re-checks rather than inheriting the assumption — spec section 4.1.
  await requireRoleOrRedirect('admin');

  const batches = await db
    .select({
      id: uploadBatch.id,
      originalFileName: uploadBatch.originalFileName,
      sheetName: uploadBatch.sheetName,
      status: uploadBatch.status,
      totalRows: uploadBatch.totalRows,
      validRows: uploadBatch.validRows,
      invalidRows: uploadBatch.invalidRows,
      duplicateRows: uploadBatch.duplicateRows,
      uploadedAt: uploadBatch.uploadedAt,
      uploadedByName: user.name,
    })
    .from(uploadBatch)
    .leftJoin(user, eq(uploadBatch.uploadedBy, user.id))
    .orderBy(desc(uploadBatch.uploadedAt))
    .limit(100);

  return (
    <section>
      <PageHeader
        title="Uploads"
        description="Each upload is stored unmodified and staged before anything reaches the master records. Nothing is written until you commit."
        actions={
          <LinkButton href="/admin/uploads/new" variant="primary">
            New upload
          </LinkButton>
        }
      />

      {batches.length === 0 ? (
        <EmptyState
          title="No workbooks imported yet"
          description="Upload the sales dashboard workbook to map its columns and review the parsed rows."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Sheet</Th>
              <Th>Status</Th>
              <Th className="text-right">Rows</Th>
              <Th className="text-right">Valid</Th>
              <Th className="text-right">Errors</Th>
              <Th className="text-right">Duplicates</Th>
              <Th>Uploaded</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                {/* Monospaced, like every other identifier in the portal. A
                    column of workbook names is scanned for the one differing
                    date or suffix, and proportional digits hide exactly that. */}
                <Td>
                  <Link
                    href={`/admin/uploads/${batch.id}`}
                    className="font-mono text-[13px] font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
                  >
                    {batch.originalFileName}
                  </Link>
                </Td>
                <Td className="font-mono text-[12px] text-slate-600">{batch.sheetName ?? '—'}</Td>
                <Td>
                  <StatusBadge status={batch.status} />
                </Td>
                <Td className="text-right tabular-nums">{batch.totalRows.toLocaleString('en-IN')}</Td>
                <Td className="text-right tabular-nums">{batch.validRows.toLocaleString('en-IN')}</Td>
                <Td className="text-right tabular-nums text-red-700">
                  {batch.invalidRows === 0 ? '—' : batch.invalidRows.toLocaleString('en-IN')}
                </Td>
                <Td className="text-right tabular-nums text-amber-700">
                  {batch.duplicateRows === 0 ? '—' : batch.duplicateRows.toLocaleString('en-IN')}
                </Td>
                <Td className="whitespace-nowrap text-[12px] text-slate-600">
                  {formatDateTime(batch.uploadedAt)}
                  <span className="block text-[11px] text-slate-400">
                    {batch.uploadedByName ?? '—'}
                  </span>
                </Td>
                {/* A committed batch renders no control at all rather than a
                    disabled one: its rows are the provenance of live records, so
                    the answer is never "not yet" — it is "not through here". The
                    component returns null for `committed`, and the prop is what
                    tells it which this row is. */}
                <Td>
                  <DeleteUploadButton
                    batchId={batch.id}
                    fileName={batch.originalFileName}
                    committed={batch.status === 'COMMITTED'}
                    compact
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
