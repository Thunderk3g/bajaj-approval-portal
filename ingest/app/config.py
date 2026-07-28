"""Environment configuration, validated once at import.

Mirrors the discipline of src/lib/env.ts on the Next.js side: a missing variable
fails at startup with a message naming it, rather than at the first request that
happens to need it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    database_url: str
    storage_root: Path
    ingest_token: str
    #: Rows streamed between progress writes. Small enough that the UI moves,
    #: large enough that a 54,507-row sheet does not cause 54,507 UPDATEs.
    progress_interval: int = 2000
    #: A RUNNING job whose heartbeat is older than this was orphaned by a
    #: restart. Reaped on startup rather than left claiming to be in progress.
    stale_job_seconds: int = 300


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is not set. The ingestion service refuses to start without it "
            f"rather than failing on the first request that needs it."
        )
    return value


def load_config() -> Config:
    storage = Path(_require("STORAGE_ROOT")).resolve()
    if not storage.is_dir():
        raise ConfigError(
            f"STORAGE_ROOT={storage} is not a directory. This is the volume holding "
            f"uploaded workbooks; without it every parse would fail at read time."
        )

    token = _require("INGEST_TOKEN")
    if len(token) < 32:
        # The token is the only thing between this service and anything else on
        # shared-network. A short one is worse than none, because it looks like
        # a control.
        raise ConfigError("INGEST_TOKEN must be at least 32 characters.")

    return Config(
        database_url=_require("DATABASE_URL"),
        storage_root=storage,
        ingest_token=token,
    )
