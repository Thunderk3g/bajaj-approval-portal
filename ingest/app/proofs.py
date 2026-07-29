"""Proof-document inspection.

The reason a Python service is worth having beyond speed. Proof attachments are
the customer documents a verifier checks a correction against, and today the
portal can only store and serve them — nobody can ask what is inside one without
opening it by hand.

This module answers the questions a verifier actually has, and deliberately
stops there:

  - Is this file really what its extension claims?
  - How many pages, and is it a scan or real text?
  - What text does it contain, so a mandate reference can be searched?

It does NOT decide anything. No auto-approval, no "the proof looks valid". A
verifier gate whose verifier is a regex is not a gate — the human is the point,
and this only saves them from squinting.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("ingest.proofs")

#: Leading bytes each accepted type must actually start with. The extension is
#: a claim made by whoever named the file; this is the check.
MAGIC: dict[str, bytes] = {
    "pdf": b"%PDF-",
    "png": b"\x89PNG\r\n\x1a\n",
    "jpg": b"\xff\xd8\xff",
    "webp": b"RIFF",
}

#: Below this, a PDF page carries so little extractable text that it is a scan.
#: Chosen from the shape of the problem rather than tuned: a real mandate page
#: has hundreds of characters, a scanned one has the handful OCR-free extraction
#: finds in headers.
SCAN_TEXT_THRESHOLD = 40


@dataclass
class ProofSummary:
    kind: str | None = None
    declared_kind: str | None = None
    magic_ok: bool = False
    size_bytes: int = 0
    pages: int | None = None
    #: True when the PDF has pages but almost no extractable text — i.e. it is a
    #: photograph of a document. Surfaced because a verifier searching for a
    #: mandate number in a scan will find nothing, and should be told why.
    looks_scanned: bool | None = None
    text_excerpt: str = ""
    references: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


#: Identifiers worth pulling out of a mandate or policy document. Deliberately
#: narrow: these are the two numbers a correction is ever about.
_APPS_NO = re.compile(r"\b\d{10}\b")
_UMRN = re.compile(r"\b[A-Z]{4}\d{10,20}\b")


def sniff_kind(head: bytes) -> str | None:
    for kind, magic in MAGIC.items():
        if head.startswith(magic):
            return kind
    return None


def inspect(path: Path, declared_extension: str | None = None) -> ProofSummary:
    """Reads a proof and reports what it is.

    Never raises for a malformed document: a proof that cannot be parsed is a
    finding a verifier needs to see, not an exception that fails their page.
    """
    summary = ProofSummary(declared_kind=(declared_extension or "").lower().lstrip(".") or None)

    try:
        summary.size_bytes = path.stat().st_size
        with path.open("rb") as handle:
            head = handle.read(16)
    except OSError as exc:
        summary.warnings.append(f"The stored file could not be read: {exc}")
        return summary

    summary.kind = sniff_kind(head)
    if summary.kind is None:
        summary.warnings.append(
            "This file does not begin with the signature of a PDF, PNG, JPEG or WebP."
        )
        return summary

    # jpg/jpeg name the same format; compare on the sniffed kind, not the text.
    declared = {"jpeg": "jpg"}.get(summary.declared_kind or "", summary.declared_kind)
    summary.magic_ok = declared is None or declared == summary.kind
    if not summary.magic_ok:
        summary.warnings.append(
            f"The file is named .{declared} but its contents are a {summary.kind.upper()}."
        )

    if summary.kind == "pdf":
        _inspect_pdf(path, summary)

    return summary


def _inspect_pdf(path: Path, summary: ProofSummary) -> None:
    try:
        from pypdf import PdfReader
    except ImportError:
        summary.warnings.append("PDF text extraction is unavailable: pypdf is not installed.")
        return

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            # An encrypted proof cannot be read by the verifier either.
            summary.warnings.append("This PDF is password-protected and cannot be read.")
            return

        summary.pages = len(reader.pages)

        chunks: list[str] = []
        # Five pages is enough to find a reference number and bounded enough that
        # a 200-page statement cannot stall the request.
        for page in reader.pages[:5]:
            try:
                chunks.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001 — one bad page must not lose the rest
                continue

        text = "\n".join(chunks).strip()
        summary.looks_scanned = bool(summary.pages) and len(text) < SCAN_TEXT_THRESHOLD
        if summary.looks_scanned:
            summary.warnings.append(
                "This looks like a scan or photograph: it has pages but almost no "
                "selectable text, so searching it for a reference will find nothing."
            )

        summary.text_excerpt = re.sub(r"\s+", " ", text)[:1200]
        summary.references = sorted(
            set(_APPS_NO.findall(text)) | set(_UMRN.findall(text))
        )[:20]

    except Exception as exc:  # noqa: BLE001
        log.warning("PDF inspection failed for %s: %s", path.name, exc)
        summary.warnings.append(f"This PDF could not be parsed: {exc}")
