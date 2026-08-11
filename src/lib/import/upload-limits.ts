/**
 * What the upload form is allowed to accept.
 *
 * Here rather than in `actions.ts` because that file is `'use server'` and may
 * only export async functions — and the browser has to know the same two rules
 * the server enforces, or a 60 MB file is uploaded in full before being told its
 * extension was never readable.
 *
 * The server still checks both. This is the copy that saves the round trip, not
 * the copy that decides.
 */

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** Formats SheetJS can read here. `.xlsb` is the one the real source uses. */
export const ALLOWED_EXTENSIONS = ['.xlsb', '.xlsx', '.xlsm', '.xls'] as const;

export const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

/** Trailing extension of a file name, lower-cased, `''` when it has none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

/** The reason this file cannot be uploaded, or null when it can. */
export function rejectUpload(file: { name: string; size: number }): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name) as (typeof ALLOWED_EXTENSIONS)[number])) {
    return `That file type cannot be read. Accepted formats: ${ALLOWED_EXTENSIONS.join(', ')}.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return `That file is too large — the maximum is ${MAX_UPLOAD_MB} MB.`;
  return null;
}

/** Human file size, one decimal above a megabyte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
