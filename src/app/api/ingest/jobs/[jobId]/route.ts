import { NextResponse } from 'next/server';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/rbac';
import { getIngestJob, IngestResponseError, IngestUnavailableError } from '@/lib/ingest/client';

/**
 * `GET /api/ingest/jobs/[jobId]` — the review page's poll target.
 *
 * This exists so the browser never holds `INGEST_TOKEN`. The service is reachable
 * only on the internal network (spec section 8) and authenticates with a shared
 * secret; a page that polled it directly would need that secret in the client
 * bundle, which would hand anyone with the page source a key to a service that
 * reads the storage volume. The token stops here.
 *
 * SECURITY: `requireRole('admin')` is called by this handler itself. Spec section
 * 4.1 — middleware redirects browsers but is not the authorization boundary, and
 * a handler reached directly has to fail closed on its own.
 *
 * A non-admin gets 404 rather than 403, matching the original-workbook route: a
 * 403 would confirm that a job with that id exists, which is a fact a non-admin
 * has no business learning.
 */

export const dynamic = 'force-dynamic';

/**
 * Job progress changes by the second and is scoped to an admin session. A shared
 * cache holding it would show the next poller a stage that has already passed.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * The service issues job ids as uuids, and nothing but a uuid is forwarded.
 *
 * The id arrives from a URL segment. Without this, `..%2Fproofs%2Finspect` would
 * address a different endpoint of the service with a valid token attached — the
 * client encodes the segment, but a handler that only relies on downstream
 * encoding is one refactor away from not doing so.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): NextResponse {
  return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  try {
    await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) return notFound();
    throw error;
  }

  const { jobId } = await params;
  if (!UUID.test(jobId)) return notFound();

  try {
    const job = await getIngestJob(jobId);
    return NextResponse.json(job, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof IngestResponseError) {
      // The service answers 404 for an unknown job and for a rejected token
      // alike, and that distinction is not this handler's to make. Anything else
      // it refuses is reported as a gateway failure so the poller can tell "the
      // job is gone" from "the hop failed".
      return error.status === 404 ? notFound() : gatewayError(error.message);
    }
    if (error instanceof IngestUnavailableError) return gatewayError(error.message);
    throw error;
  }
}

/**
 * 503, not 500: the failure is in the hop to another service, and the poller
 * uses that to keep retrying rather than giving up as it would on a real fault.
 */
function gatewayError(message: string): NextResponse {
  return NextResponse.json(
    { error: 'INGEST_UNAVAILABLE', message },
    { status: 503, headers: NO_STORE },
  );
}
