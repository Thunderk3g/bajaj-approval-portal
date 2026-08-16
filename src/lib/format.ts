/**
 * Display formatting. Presentation only — never used on a value being stored.
 *
 * Money in particular arrives from Postgres as a string and stays a string all
 * the way to the DOM. Parsing it to a JS number just to render it would
 * reintroduce exactly the floating-point drift that numeric(18,2) exists to
 * prevent, so the grouping below is done on the digits themselves.
 */

/** Renders a numeric(18,2) string with thousands separators, without parsing it. */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = '00'] = value.replace(/^[+-]/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${(fraction + '00').slice(0, 2)}`;
}

/** `YYYY-MM-DD` (or a Date) to `DD MMM YYYY`. Dates are stored date-only. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const parsed = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed)) return String(value);
  const d = new Date(parsed);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${month} ${d.getUTCFullYear()}`;
}

/**
 * The one timezone every timestamp in this portal is read in.
 *
 * Pinned rather than left to the host. Without it `toLocaleString` renders in
 * whatever zone the process happens to run in — IST on a developer's laptop,
 * UTC inside the container — so the same instant reads 5.5 hours apart
 * depending on where it was rendered, and shifts on redeploy with nothing on
 * screen to say it moved. The business runs on one clock; so does the display.
 *
 * Not the viewer's zone either: an approval timestamp is evidence, quoted
 * between people on a call, and two people reading the same audit row have to
 * see the same time.
 */
const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

/** Timestamps are true instants, not dates — rendered on the business clock. */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Whole days between then and now, for queue ageing. */
export function ageInDays(from: Date | string): number {
  const d = from instanceof Date ? from : new Date(from);
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

/** An em dash beats an empty cell: it says "no value" rather than "not rendered". */
export function orDash(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = String(value).trim();
  return text === '' ? '—' : text;
}
