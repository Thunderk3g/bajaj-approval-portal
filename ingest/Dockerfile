# ──────────────────────────────────────────────────────────────────────────
# reconciliation-ingest — the workbook parsing and proof inspection service
#
# Multi-stage. The runtime image carries a pre-built virtualenv and the `app`
# package and nothing else — no pip cache, no tests, no fixtures cut from the
# real workbook, and no compiler.
#
# Base and style follow compliance-agent/backend/Dockerfile, which is the
# platform's existing FastAPI convention. It builds from this directory:
#
#   podman build -t localhost/reconciliation-ingest:latest ingest/   # dev box
#   podman save localhost/reconciliation-ingest:latest | gzip > ingest.tar.gz
#   # move the tarball to the VM, then:
#   gunzip -c ingest.tar.gz | sudo podman load
#
# Unlike the portal's own Dockerfile this one has no CDN dependency — every
# requirement resolves to a PyPI wheel — so it can be built on the VM too. It
# is still loaded rather than built there, because `pull_policy: never` means
# the image must be present locally either way and one path is easier to keep
# right than two.
#
# ── PORT 8006, NOT 8005 ───────────────────────────────────────────────────
# The port registry's next free backend slot was 8005. This service uses 8006
# and 8005 is deliberately left unassigned, because 8005 falls inside a
# Windows TCP port-exclusion range (Hyper-V/WinNAT reserves blocks of them;
# see `netsh interface ipv4 show excludedportrange protocol=tcp`) on the
# developer machines. Binding an excluded port fails with a bare
# "permission denied" / WSAEACCES that names neither Windows nor the
# exclusion, so a developer running `uvicorn --port 8005` outside a container
# loses an afternoon to a port that is simply not theirs to bind. The RHEL VM
# does not care, but a service that only works in one of its two supported
# environments is a trap. 8006 works in both, and the number is the same
# everywhere — Dockerfile, compose, healthcheck, INGEST_URL — so there is no
# mapping to get wrong.
# ──────────────────────────────────────────────────────────────────────────

# ── deps ──────────────────────────────────────────────────────────────────
FROM docker.io/library/python:3.11-slim AS deps

# A virtualenv rather than the system site-packages, purely so the runtime
# stage can take the dependencies as ONE directory. Without it the install
# scatters across /usr/local/lib and /usr/local/bin and the runtime stage
# either copies too much or misses the console scripts.
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app

# Only the manifest, so this layer is re-used whenever app/ changes but the
# dependencies do not — which is most rebuilds, and this layer is the slow one.
COPY requirements.txt ./

# --only-binary=:all: is the enforcement of "no build toolchain in this image".
# Every requirement resolves to a manylinux wheel today, python-calamine (a
# Rust extension, the one most likely to need cargo) included. If a future
# dependency ships only an sdist, this fails HERE with pip naming the package,
# rather than deep in a C compile against a compiler that is not installed. The
# fix when that day comes is to apt-get build-essential in THIS stage only —
# the stage split exists so that stays a one-line change that cannot leak a
# compiler into the runtime image.
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

# ── runtime ───────────────────────────────────────────────────────────────
FROM docker.io/library/python:3.11-slim AS runtime

ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    # Unbuffered, or uvicorn's log lines sit in a pipe buffer and the
    # k8s-file driver writes them to /var/log/apps minutes late — which during
    # an incident reads as "the service stopped logging".
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Non-root, and specifically uid 1001 — the SAME uid the portal image runs as
# (see ../Dockerfile, user `nextjs`). Both containers mount the one
# reconciliation-storage volume, and the portal is the writer: every uploaded
# workbook and proof under it is owned by 1001. Running this service as any
# other uid would leave it reading customer documents through the world bits
# alone, and unable to write beside them at all. Matching uids is the whole
# reason the shared volume works.
RUN groupadd --system --gid 1001 ingest \
 && useradd  --system --uid 1001 --gid ingest --home /app ingest

WORKDIR /app

COPY --from=deps /opt/venv /opt/venv
COPY --chown=ingest:ingest app ./app

# The mount point for the reconciliation-storage volume. Created here, owned by
# the runtime user, because config.load_config() refuses to start when
# STORAGE_ROOT is not a directory — and because on a FIRST start the container
# runtime seeds an empty named volume from the image, ownership included, so
# creating it correctly here is what makes the volume writable at all.
RUN mkdir -p /app/storage && chown ingest:ingest /app/storage

USER ingest
EXPOSE 8006

# The service's own /health, not a TCP probe. It runs `select 1` through the
# psycopg pool, so a process that is up but cannot reach shared-postgres —
# wrong RECONCILIATION_DB_PASSWORD, database not yet created, postgres down —
# reports 503 and therefore unhealthy, instead of looking fine while every
# upload fails. urlopen raises on 503 and exits non-zero, which is what the
# healthcheck wants.
#
# start-period covers the lifespan startup: pool open, verify_schema(), and the
# reap of jobs orphaned by the previous restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8006/health',timeout=4)" || exit 1

# One worker, deliberately. Job ROWS live in Postgres, but the work runs in
# this process's ThreadPoolExecutor (2 threads, sized in app/main.py against
# the GIL behaviour of calamine/pyxlsb). A second uvicorn worker would be a
# second pool and a second startup reaper, each reaping the other's live jobs
# to FAILED. Scale this service by making the threads work, not by forking it.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8006", "--workers", "1"]
