import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PROOFS_DIR, allocateStoragePath, resolveStoredPath } from './paths';

/**
 * Proof file handling — spec section 4.4.
 *
 * Proof attachments are customer documents. They are the sensitive artefact in
 * this system, and every rule below exists because of a specific way a file
 * upload becomes an attack on the people who later open it.
 */

/** 10 MB per file, 5 files per request — section 4.4. */
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export const MAX_PROOFS_PER_REQUEST = 5;

/** Original names are for display only; a novel-length one is a UI attack. */
const MAX_ORIGINAL_NAME_LENGTH = 200;

export type ProofKind = 'png' | 'jpeg' | 'webp' | 'pdf';

type KindSpec = {
  /** The filename extensions that are allowed to carry this content. */
  extensions: readonly string[];
  /** The extension written to disk — from this allowlist, never from the upload. */
  storedExtension: string;
  mimeType: string;
  /** Whether it is safe to render in an `<img>` for a thumbnail. */
  previewable: boolean;
};

const KINDS: Record<ProofKind, KindSpec> = {
  png: { extensions: ['.png'], storedExtension: 'png', mimeType: 'image/png', previewable: true },
  jpeg: {
    extensions: ['.jpg', '.jpeg'],
    storedExtension: 'jpg',
    mimeType: 'image/jpeg',
    previewable: true,
  },
  webp: {
    extensions: ['.webp'],
    storedExtension: 'webp',
    mimeType: 'image/webp',
    previewable: true,
  },
  pdf: {
    extensions: ['.pdf'],
    storedExtension: 'pdf',
    mimeType: 'application/pdf',
    previewable: false,
  },
};

export const ACCEPTED_EXTENSIONS: readonly string[] = Object.values(KINDS).flatMap(
  (spec) => spec.extensions,
);

/** For the file input's `accept` attribute — a hint to the picker, not a control. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

export const PREVIEWABLE_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(KINDS)
    .filter((spec) => spec.previewable)
    .map((spec) => spec.mimeType),
);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Identifies a file by what it CONTAINS, not by what it is called.
 *
 * An extension is a claim made by whoever uploaded the file. Trusting it is how
 * an HTML document arrives as `proof.png`, gets served back with
 * `Content-Type: image/png`, and — in a browser that sniffs, or through any
 * viewer that re-reads the extension — executes in the origin that is showing it
 * to an approver. The magic bytes are the only part of an upload the uploader
 * cannot lie about while still producing a working file.
 *
 * Signatures are the leading bytes of each format's header:
 *   PNG   89 50 4E 47 0D 0A 1A 0A  (the trailing bytes catch newline mangling)
 *   JPEG  FF D8 FF                  (SOI plus the first marker)
 *   PDF   25 50 44 46               ("%PDF")
 *   WebP  52 49 46 46 .... 57 45 42 50  ("RIFF" <size> "WEBP")
 */
export function sniffProofKind(bytes: Uint8Array): ProofKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  return null;
}

/** The kind a filename claims to be, from the extension allowlist only. */
export function extensionKind(fileName: string): ProofKind | null {
  const ext = extname(fileName).toLowerCase();
  for (const [kind, spec] of Object.entries(KINDS)) {
    if (spec.extensions.includes(ext)) return kind as ProofKind;
  }
  return null;
}

export type ProofUpload = {
  /** The name the browser reported. Display only — it never reaches a path. */
  name: string;
  bytes: Uint8Array;
};

export type ProofValidation =
  | { ok: true; kind: ProofKind; mimeType: string; storedExtension: string; originalName: string }
  | { ok: false; reason: string };

export function validateProofUpload(upload: ProofUpload): ProofValidation {
  const name = upload.name.trim() || 'proof';
  const size = upload.bytes.byteLength;

  if (size === 0) return { ok: false, reason: `"${name}" is empty.` };

  if (size > MAX_PROOF_BYTES) {
    return {
      ok: false,
      reason: `"${name}" is ${(size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_PROOF_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const claimed = extensionKind(name);
  if (!claimed) {
    return {
      ok: false,
      reason: `"${name}" is not an accepted file type. Upload ${ACCEPTED_EXTENSIONS.join(', ')}.`,
    };
  }

  const actual = sniffProofKind(upload.bytes);
  if (!actual) {
    return { ok: false, reason: `"${name}" is not a readable image or PDF.` };
  }

  // The mismatch case: a file whose extension and content disagree. Renaming an
  // HTML page or a script to .png is the cheapest way to smuggle active content
  // past an upload filter, so the two must agree or the file is refused.
  if (actual !== claimed) {
    return {
      ok: false,
      reason: `"${name}" is not really a ${extname(name).toLowerCase()} file — its contents say otherwise.`,
    };
  }

  const spec = KINDS[actual];
  return {
    ok: true,
    kind: actual,
    mimeType: spec.mimeType,
    storedExtension: spec.storedExtension,
    originalName: name.slice(0, MAX_ORIGINAL_NAME_LENGTH),
  };
}

export type StoredProof = {
  /** Relative to the storage root — what goes in `correction_attachment.stored_path`. */
  relativePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type StoreProofsResult =
  | { ok: true; stored: StoredProof[] }
  | { ok: false; reason: string };

/**
 * Validates every upload BEFORE writing any of them, then writes.
 *
 * Two properties fall out of that ordering. A request with one bad file leaves
 * nothing at all on disk, so a rejected submission cannot be used to drip
 * unreferenced bytes into storage. And the caller gets every problem in one
 * message instead of discovering them one resubmission at a time.
 *
 * If a write fails part way, the files already written are removed: an orphaned
 * file is harmless, but a half-stored request that later gets rows written for
 * it is not.
 */
export async function storeProofUploads(uploads: ProofUpload[]): Promise<StoreProofsResult> {
  if (uploads.length === 0) {
    return { ok: false, reason: 'Attach at least one proof document.' };
  }

  if (uploads.length > MAX_PROOFS_PER_REQUEST) {
    return {
      ok: false,
      reason: `Attach at most ${MAX_PROOFS_PER_REQUEST} proof documents.`,
    };
  }

  const validated: { upload: ProofUpload; validation: Extract<ProofValidation, { ok: true }> }[] =
    [];
  const rejections: string[] = [];

  for (const upload of uploads) {
    const validation = validateProofUpload(upload);
    if (validation.ok) validated.push({ upload, validation });
    else rejections.push(validation.reason);
  }

  if (rejections.length > 0) return { ok: false, reason: rejections.join(' ') };

  const stored: StoredProof[] = [];

  try {
    for (const { upload, validation } of validated) {
      // The filename is a UUID and the extension comes from the allowlist above,
      // so nothing the uploader controls reaches the path — section 4.4.
      const { absolutePath, relativePath } = await allocateStoragePath(
        PROOFS_DIR,
        validation.storedExtension,
      );

      await writeFile(absolutePath, upload.bytes);

      stored.push({
        relativePath,
        originalName: validation.originalName,
        mimeType: validation.mimeType,
        sizeBytes: upload.bytes.byteLength,
        // Recorded so a proof can be shown to be the same bytes that were
        // submitted, months later, when an approval is being questioned.
        sha256: createHash('sha256').update(upload.bytes).digest('hex'),
      });
    }
  } catch (error) {
    await deleteStoredProofs(stored.map((s) => s.relativePath));
    throw error;
  }

  return { ok: true, stored };
}

/**
 * Best-effort removal, used when the database transaction that would have
 * referenced these files rolled back.
 *
 * Failures are swallowed on purpose: the files are already unreferenced, and
 * turning a cleanup failure into a request failure would report an error for an
 * operation that actually succeeded.
 */
export async function deleteStoredProofs(relativePaths: string[]): Promise<void> {
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      try {
        await unlink(resolveStoredPath(relativePath));
      } catch {
        // Nothing to do — an orphaned proof file harms nobody.
      }
    }),
  );
}

export async function readStoredProof(relativePath: string): Promise<Buffer> {
  return readFile(resolveStoredPath(relativePath));
}

/**
 * Builds a `Content-Disposition` value from a name the uploader chose.
 *
 * The original name is the one piece of uploader-controlled text that reaches a
 * response header, and a header is a line-oriented format: a CR or LF in the
 * value splits it and lets the uploader append headers of their own. A quote
 * ends the quoted string early and does the same thing to the parameters. Both
 * are stripped rather than escaped, and the ASCII form is paired with the
 * RFC 5987 `filename*` so a Devanagari filename still arrives intact.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
  const fallback =
    name
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\;\r\n]/g, '_')
      .slice(0, MAX_ORIGINAL_NAME_LENGTH) || 'proof';

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
