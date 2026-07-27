/**
 * Offset pagination — spec section 9.1.
 *
 * Offset rather than keyset deliberately: the record grid sorts on arbitrary
 * columns and, when a search term is present, on trigram relevance. Keyset
 * pagination does not combine cleanly with either, and at the volumes here
 * (low thousands of rows) the offset cost is not worth the complexity.
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type PageParams = { page: number; pageSize: number; offset: number };

/**
 * Parses page controls from a URL search param, clamping rather than rejecting.
 *
 * A hand-edited `?pageSize=100000` is a denial-of-service vector against the
 * database, not a user error worth a message, so it is clamped to the largest
 * offered size. Everything unparseable falls back to the default.
 */
export function parsePageParams(params: {
  page?: string | string[] | undefined;
  pageSize?: string | string[] | undefined;
}): PageParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const rawPage = Number(first(params.page));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const rawSize = Number(first(params.pageSize));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize)
    ? rawSize
    : DEFAULT_PAGE_SIZE;

  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Preserves every existing filter while changing one param — used by page links. */
export function buildQuery(
  current: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(current)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== '') search.append(key, v);
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    search.delete(key);
    if (value !== undefined && value !== '') search.set(key, String(value));
  }

  const text = search.toString();
  return text ? `?${text}` : '';
}
