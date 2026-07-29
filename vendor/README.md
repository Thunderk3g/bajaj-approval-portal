# vendor/

## `xlsx-0.20.3.tgz`

SheetJS, committed to the repository rather than fetched at install time.

**Why not the npm registry.** The `xlsx` package on the public registry is
abandoned; its last published release carries unpatched prototype-pollution and
ReDoS advisories. SheetJS distributes current versions from `cdn.sheetjs.com`
only, which is why `package.json` pinned the CDN URL directly.

**Why not the CDN.** That URL cannot be fetched from either place this image is
built:

- **The Bajaj AI Platform VM** does not have `cdn.sheetjs.com` on its outbound
  whitelist (`infra-access-request.md`), so `npm ci` fails there outright.
- **A developer machine behind the corporate TLS interception** fails inside the
  build container with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The host's Windows
  trust store carries the interception CA and the `node:20-slim` container's does
  not, so `npm install` works on the host and `docker compose build` does not —
  which is a genuinely confusing pair of outcomes to debug.

Vendoring is the option `docs/deploy-vm.md` already listed for the first of
those. It fixes both, and it removes a network dependency from every build.

**Provenance.** Downloaded from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and verified byte-identical
to the integrity hash the previous `package-lock.json` had already pinned:

```
sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==
```

That check is the point of recording it here. The file was fetched through the
corporate proxy, which terminates TLS — matching a hash that was written down
before this change is what rules out anything having been substituted in transit.

**Upgrading.** Download the new tarball, confirm its `sha512` against what
SheetJS publishes, replace this file, and update the path in `package.json`.
Do not switch back to a URL dependency: the build hosts have not changed.
