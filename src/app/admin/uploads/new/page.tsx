import type { Metadata } from 'next';
import { requireRole } from '@/lib/auth/rbac';
import { Card, PageHeader } from '@/components/ui';
import { UploadForm } from '../_components/upload-form';

export const metadata: Metadata = {
  title: 'New upload · Sales Data Review Portal',
};

export default async function NewUploadPage() {
  await requireRole('admin');

  return (
    <section>
      <PageHeader
        title="New upload"
        description="Uploading only stores and hashes the file. You will choose the sheet, confirm the column mapping and review the parsed rows before anything is written to the master records."
      />

      <Card>
        <UploadForm />
      </Card>
    </section>
  );
}
