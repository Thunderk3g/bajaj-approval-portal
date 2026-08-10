import { count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower } from '@/db/schema';

/**
 * Whether a usable roster exists — the precondition for importing transactions.
 *
 * The Manpower sheet is the only thing that places a rep under a team leader and
 * that team leader under an area manager. Import the business dashboard first and
 * every SM_ID it carries becomes a rep the system knows by code and by nothing
 * else: mapping corrections skip the TL and ACM steps entirely because there is
 * nobody to route them to, and the gaps are invisible until somebody raises one.
 *
 * "Usable" deliberately excludes orphan rows. `flagOrphans` writes a `manpower`
 * row for every SM_ID a transaction sheet mentions and the roster does not, so a
 * bare row count would report a roster the moment a dashboard was imported —
 * satisfying the gate with exactly the placeholders the gate exists to prevent.
 * Only a row that actually places somebody counts.
 */
export type RosterState = {
  ready: boolean;
  placed: number;
  orphans: number;
};

export async function rosterState(): Promise<RosterState> {
  const [[placed], [orphans]] = await Promise.all([
    db.select({ value: count() }).from(manpower).where(eq(manpower.isOrphan, false)),
    db.select({ value: count() }).from(manpower).where(eq(manpower.isOrphan, true)),
  ]);

  return {
    ready: (placed?.value ?? 0) > 0,
    placed: placed?.value ?? 0,
    orphans: orphans?.value ?? 0,
  };
}

/**
 * A commit refused because a precondition was not met, rather than because a row
 * was wrong.
 *
 * Its own type so the action layer can show it as an instruction — "import a
 * roster first" — instead of the generic failure it would otherwise become. The
 * batch is left VALIDATED, so the admin fixes the precondition and presses
 * Commit again rather than re-uploading.
 */
export class ImportPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportPreconditionError';
  }
}

export const ROSTER_REQUIRED_MESSAGE =
  'Commit the Manpower sheet first. The roster is what places every rep under a team leader and area manager, and the policies are mapped against it — without it, records import but no mapping correction can be routed for approval. Use "Commit the roster" above, then commit the policies.';
