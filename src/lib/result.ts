/**
 * The return contract for every Server Action in this app.
 *
 * Actions return a discriminated result rather than throwing across the
 * server/client boundary. Next.js redacts thrown error messages in production,
 * so a thrown validation failure reaches the user as "an error occurred" — which
 * is useless when the actual problem is "the description is required".
 *
 * AuthzError is the deliberate exception: it is caught by the page's layout and
 * turned into a redirect, so it must keep propagating.
 */

export type FieldErrors = Record<string, string[]>;

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export function ok(): ActionResult<void>;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T | void> {
  return { ok: true, data: data as T };
}

export function fail(error: string, fieldErrors?: FieldErrors): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/** Flattens a Zod v4 error into the field-error shape forms render. */
export function zodFieldErrors(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join('.') : '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
