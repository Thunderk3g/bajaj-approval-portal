import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatch } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/rbac';
import { resolveStoredPath } from '@/lib/storage/paths';

/**
 * `GET /api/uploads/[id]/original` — the immutable source workbook.
 *
 * SECURITY: this handler calls `requireRole('admin')` itself. Spec section 4.1 —
 * middleware redirects but is not the authorization boundary, and a route
 * handler reached directly must fail closed on its own.
 *
 * A caller who is not an admin gets 404, not 403. A 403 would confirm that a
 * batch with that id exists, which is a fact a non-admin has no business
 * learning.
 *
 * The file is only ever opened for reading. Spec section 1: the uploaded
 * workbook is never modified — it is one of the three independent ways an
 * original value survives, alongside version 1 of the record and the
 * `original_value` snapshot on a correction request.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
};

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let actor;
  try {
    actor = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) return notFound();
    throw error;
  }

  const { id } = await params;

  const [batch] = await db
    .select({
      id: uploadBatch.id,
      storedPath: uploadBatch.storedPath,
      originalFileName: uploadBatch.originalFileName,
      fileHash: uploadBatch.fileHash,
    })
    .from(uploadBatch)
    .where(eq(uploadBatch.id, id));

  if (!batch) return notFound();

  let absolutePath: string;
  let size: number;
  try {
    absolutePath = resolveStoredPath(batch.storedPath);
    size = (await stat(absolutePath)).size;
  } catch {
    return notFound();
  }

  await writeAudit({
    actor,
    action: 'UPLOAD_ORIGINAL_DOWNLOAD',
    entityType: 'upload_batch',
    entityId: batch.id,
    metadata: { originalFileName: batch.originalFileName, fileHash: batch.fileHash },
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: request.headers.get('user-agent'),
  });

  const extension = extname(batch.originalFileName).toLowerCase();
  const stream = Readable.toWeb(createReadStream(absolutePath)) as ReadableStream<Uint8Array>;

  return new Response(stream, {
    headers: {
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(size),
      // The filename is quoted and stripped of quotes and control characters:
      // it is the only part of this response derived from a name a user chose.
      'Content-Disposition': `attachment; filename="${batch.originalFileName.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  });
}
