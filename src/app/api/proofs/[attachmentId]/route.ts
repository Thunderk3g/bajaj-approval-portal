import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionRequest, salesRecord } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import {
  GLOBAL_READ_ROLES,
  requireSession,
  scopedRecordCondition,
  type SessionUser,
} from '@/lib/auth/rbac';
import { PREVIEWABLE_MIME_TYPES, contentDisposition, readStoredProof } from '@/lib/storage/files';

/**
 * The only route that serves a proof document — spec section 4.4.
 *
 * Proof files live in `storage/proofs/`, outside `public/`, so there is no
 * static URL that reaches them and this handler is the sole way in. It
 * authorizes before it reads a byte, and it authorizes here rather than relying
 * on the middleware, because a Route Handler is reachable directly (section
 * 4.1).
 *
 * The response is built to be inert. `X-Content-Type-Options: nosniff` stops a
 * browser second-guessing the recorded MIME type; `Content-Security-Policy:
 * default-src 'none'` means that even if a file somehow got past magic-byte
 * validation carrying markup, it has no script, no styles, no frames and no
 * network access in the origin an approver is viewing it from.
 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * THE decision of this file: everything unauthorized is 404, never 403.
 *
 * A 403 is an answer. It tells a caller who guessed an attachment id that the
 * id was right — that this document exists, that some correction request
 * references it, and that it is worth attacking further. Attachment ids appear
 * in URLs and in notification links, so "I got 403 not 404" is a real
 * distinction an outsider can act on. Returning the same 404 for "no such
 * attachment", "not yours" and "not signed in" means the response carries no
 * information at all about which of the three it was.
 */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function canView(user: SessionUser, submittedBy: string): boolean {
  // Section 4.4: Admin, or a reviewing role, or the Sales user who submitted the
  // parent request. A sales user's own SM_ID is not the test — a mapping claim
  // is raised against a record belonging to somebody else, so scoping by SM_ID
  // would lock the submitter out of the proof they uploaded themselves.
  //
  // GLOBAL_READ_ROLES includes `verifier` as of the 2026-07-28 spec. That is not
  // a widening for convenience: verification IS the act of reading the proof
  // against the claim, so a verifier locked out of attachments could only ever
  // rubber-stamp, which is worse than no gate at all.
  if (GLOBAL_READ_ROLES.includes(user.role)) return true;
  return user.id === submittedBy;
}

/**
 * A team leader or area manager whose own team the request concerns.
 *
 * Their rung is a review step, and reviewing IS reading the proof against the
 * claim — the same argument that put `verifier` in `GLOBAL_READ_ROLES`, one level
 * down. Without this a manager could approve or send back a document they were
 * served a 404 for, which is not a gate, it is a rubber stamp with extra steps.
 *
 * Scoped rather than granted by role: `scopedRecordCondition` is the same
 * predicate that bounds every record read, so a manager reaches the proofs
 * attached to their own team's records and no others. Asked as its own query
 * only when the cheap checks have already failed, so the common paths pay
 * nothing for it.
 */
async function managerMayView(user: SessionUser, requestId: string): Promise<boolean> {
  if (user.role !== 'tl' && user.role !== 'acm') return false;

  const [hit] = await db
    .select({ one: sql`1` })
    .from(correctionRequest)
    .innerJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .where(and(eq(correctionRequest.id, requestId), scopedRecordCondition(user)))
    .limit(1);

  return Boolean(hit);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { attachmentId } = await context.params;

  let user: SessionUser;
  try {
    user = await requireSession();
  } catch {
    // Not signed in, or deactivated. Still 404 — see above.
    return notFound();
  }

  // Checked before the query so a malformed id fails as a miss rather than as a
  // Postgres uuid cast error, which would be a 500 and, by its absence on valid
  // ids, an oracle of its own.
  if (!UUID.test(attachmentId)) return notFound();

  const [row] = await db
    .select({
      id: correctionAttachment.id,
      storedPath: correctionAttachment.storedPath,
      originalName: correctionAttachment.originalName,
      mimeType: correctionAttachment.mimeType,
      sizeBytes: correctionAttachment.sizeBytes,
      requestId: correctionAttachment.requestId,
      submittedBy: correctionRequest.submittedBy,
      appsNo: correctionRequest.appsNo,
    })
    .from(correctionAttachment)
    .innerJoin(correctionRequest, eq(correctionAttachment.requestId, correctionRequest.id))
    .where(eq(correctionAttachment.id, attachmentId))
    .limit(1);

  if (!row) return notFound();
  if (!canView(user, row.submittedBy) && !(await managerMayView(user, row.requestId))) {
    return notFound();
  }

  let bytes: Buffer;
  try {
    bytes = await readStoredProof(row.storedPath);
  } catch {
    // The row exists but the file does not — a restore gone wrong, or a stored
    // path that has been tampered with and was refused by `resolveStoredPath`.
    // Not the caller's business either way.
    return notFound();
  }

  // Section 4.4: EVERY view is written to the audit log. Awaited before the
  // response is returned, not fired off alongside it — a view that failed to
  // record is a view that, as far as any later investigation is concerned,
  // never happened. Customer documents are exactly the thing you have to be
  // able to say who looked at.
  await writeAudit({
    actor: user,
    action: 'ATTACHMENT_VIEW',
    entityType: 'correction_attachment',
    entityId: row.id,
    metadata: {
      requestId: row.requestId,
      appsNo: row.appsNo,
      originalName: row.originalName,
      mimeType: row.mimeType,
    },
    ipAddress: request.headers.get('x-forwarded-for'),
    userAgent: request.headers.get('user-agent'),
  });

  // Images render inline so the approver sees the proof beside the claim rather
  // than downloading it one at a time. PDFs are sent as attachments: an inline
  // PDF is handed to the browser's own viewer, which is a far larger surface
  // than an <img> and one this CSP cannot constrain.
  const disposition = PREVIEWABLE_MIME_TYPES.has(row.mimeType) ? 'inline' : 'attachment';

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': row.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': contentDisposition(disposition, row.originalName),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Customer documents must not be held by a shared cache, and must not
      // survive in the browser cache of a machine after the session ends.
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}
