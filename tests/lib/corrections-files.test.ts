import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_EXTENSIONS,
  MAX_PROOF_BYTES,
  contentDisposition,
  extensionKind,
  sniffProofKind,
  validateProofUpload,
} from '@/lib/storage/files';

/* ------------------------------------------------------- real file headers */

/** A genuine 1x1 transparent PNG, header and all. */
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** JFIF start-of-image plus the APP0 marker, then end-of-image. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** `RIFF` <size> `WEBP` `VP8 ` — the container header WebP is identified by. */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x0e, 0x00, 0x00, 0x00,
]);

const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8'));

/** The attack this validation exists for: active content wearing an image name. */
const HTML = new Uint8Array(
  Buffer.from('<!DOCTYPE html><script>fetch("/api/proofs")</script>', 'utf8'),
);

describe('magic-byte sniffing (spec 4.4)', () => {
  it('identifies a real PNG header', () => {
    expect(sniffProofKind(PNG)).toBe('png');
  });

  it('identifies JPEG, WebP and PDF headers', () => {
    expect(sniffProofKind(JPEG)).toBe('jpeg');
    expect(sniffProofKind(WEBP)).toBe('webp');
    expect(sniffProofKind(PDF)).toBe('pdf');
  });

  it('does not mistake a RIFF container that is not WebP', () => {
    // A WAV file also starts with RIFF; only the bytes at offset 8 separate them.
    const wav = new Uint8Array(WEBP);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffProofKind(wav)).toBeNull();
  });

  it('returns null for content that matches no accepted format', () => {
    expect(sniffProofKind(HTML)).toBeNull();
    expect(sniffProofKind(new Uint8Array([0x00]))).toBeNull();
    expect(sniffProofKind(new Uint8Array())).toBeNull();
  });

  it('reads the claimed kind from the extension allowlist only', () => {
    expect(extensionKind('scan.PNG')).toBe('png');
    expect(extensionKind('scan.jpeg')).toBe('jpeg');
    expect(extensionKind('scan.JPG')).toBe('jpeg');
    expect(extensionKind('scan.pdf')).toBe('pdf');
    expect(extensionKind('scan.svg')).toBeNull();
    expect(extensionKind('scan.html')).toBeNull();
    expect(extensionKind('scan')).toBeNull();
  });
});

describe('proof upload validation (spec 4.4)', () => {
  it('accepts each permitted type and records its real MIME type', () => {
    const cases = [
      { name: 'proof.png', bytes: PNG, mimeType: 'image/png', ext: 'png' },
      { name: 'proof.jpg', bytes: JPEG, mimeType: 'image/jpeg', ext: 'jpg' },
      { name: 'proof.jpeg', bytes: JPEG, mimeType: 'image/jpeg', ext: 'jpg' },
      { name: 'proof.webp', bytes: WEBP, mimeType: 'image/webp', ext: 'webp' },
      { name: 'proof.pdf', bytes: PDF, mimeType: 'application/pdf', ext: 'pdf' },
    ];

    for (const c of cases) {
      const result = validateProofUpload({ name: c.name, bytes: c.bytes });
      expect(result.ok, c.name).toBe(true);
      if (result.ok) {
        expect(result.mimeType).toBe(c.mimeType);
        // The stored extension comes from the allowlist, never from the upload:
        // ".jpeg" and ".JPG" both land on "jpg".
        expect(result.storedExtension).toBe(c.ext);
      }
    }
  });

  it('rejects a renamed file whose header says otherwise', () => {
    // The whole point of section 4.4: an extension is a claim the uploader
    // makes, and this is the case where the claim is a lie.
    const result = validateProofUpload({ name: 'proof.png', bytes: HTML });
    expect(result.ok).toBe(false);
  });

  it('rejects a genuine PNG that claims to be a PDF', () => {
    const result = validateProofUpload({ name: 'statement.pdf', bytes: PNG });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not really/i);
  });

  it('rejects an extension outside the allowlist even with valid content', () => {
    const result = validateProofUpload({ name: 'proof.gif', bytes: PNG });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not an accepted file type/i);
  });

  it('rejects an empty file', () => {
    expect(validateProofUpload({ name: 'proof.png', bytes: new Uint8Array() }).ok).toBe(false);
  });

  it('rejects a file over 10 MB', () => {
    const oversized = new Uint8Array(MAX_PROOF_BYTES + 1);
    oversized.set(PNG.subarray(0, 8));
    const result = validateProofUpload({ name: 'huge.png', bytes: oversized });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/10 MB/);
  });

  it('offers exactly the five accepted extensions', () => {
    expect([...ACCEPTED_EXTENSIONS].sort()).toEqual(['.jpeg', '.jpg', '.pdf', '.png', '.webp']);
  });
});

describe('content-disposition hardening', () => {
  it('strips the characters that would let a filename forge a header', () => {
    // A CR or LF in a header value splits it; a quote closes the parameter
    // early. Both would let the uploader append headers of their own.
    const value = contentDisposition('attachment', 'evil"\r\nSet-Cookie: a=b.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.match(/"/g)).toHaveLength(2);
  });

  it('keeps a non-ASCII name intact in the RFC 5987 parameter', () => {
    const value = contentDisposition('inline', 'प्रमाण.png');
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent('प्रमाण.png'));
  });
});
