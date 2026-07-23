import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

// A cached health check would report the state of the last build, not of now.
export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the container orchestrator.
 *
 * The response body is a fixed shape and never carries the caught error. A
 * failed connection message from pg embeds the host, port, user and database
 * name, and this endpoint is reachable without authentication.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: 'ok', database: 'up' });
  } catch {
    console.error('[health] database probe failed');
    return NextResponse.json({ status: 'degraded', database: 'down' }, { status: 503 });
  }
}
