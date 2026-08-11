/**
 * The Postgres error underneath whatever the driver wrapped it in.
 *
 * Drizzle raises a `DrizzleQueryError` and hangs the `pg` error off `cause`, so
 * reading `error.code` off what was caught finds `undefined` — and a
 * `if (code === '23503')` written that way never fires. It does not fail loudly
 * either: the branch is skipped, the error is rethrown, and a foreign-key
 * refusal that was supposed to become a sentence reaches the user as a 500.
 *
 * Walks the whole cause chain rather than checking one level, because the depth
 * is a driver detail and has already changed once.
 */
export type PgError = {
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
};

export function pgError(error: unknown): PgError | null {
  let cursor: unknown = error;

  // Bounded: a cause chain that long is a cycle, and this runs inside a catch
  // that is already handling something going wrong.
  for (let depth = 0; cursor && typeof cursor === 'object' && depth < 8; depth += 1) {
    const candidate = cursor as PgError & { cause?: unknown };
    if (typeof candidate.code === 'string') return candidate;
    cursor = candidate.cause;
  }

  return null;
}
