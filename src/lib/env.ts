import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().min(1),
  /**
   * Extra origins Better Auth will accept a state-changing request from,
   * comma-separated — e.g. `http://10.3.5.99,http://portal.example.com`.
   *
   * The origin of BETTER_AUTH_URL is trusted automatically and does not need
   * repeating here. This exists because the portal answers on more than one
   * hostname, and every sign-in POST carries the browser's `Origin` header:
   * Better Auth's origin-check middleware refuses one it does not recognise with
   * INVALID_ORIGIN (403), which the login form reports as "Incorrect email or
   * password." A hostname missing from this list therefore looks exactly like
   * the whole team's passwords being wrong.
   *
   * Runtime, not build-time: adding a hostname here is a container restart, not
   * an image rebuild. Origins only — scheme and host, no path.
   */
  TRUSTED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /**
   * Whether the session cookie carries the `Secure` attribute.
   *
   * Defaults to true, and MUST stay true anywhere the app is reachable over
   * HTTPS. It exists only because the Bajaj AI Platform's shared-nginx ingress
   * listens on plain `:80`: a Secure cookie is accepted by the browser and then
   * never sent back, which presents as an infinite login loop that looks like a
   * wrong password.
   *
   * Setting this false is a real weakening, not a config detail — session
   * cookies then cross the corporate LAN in clear text and anyone on-path can
   * replay one for the eight hours it lives. It is a stopgap until TLS
   * terminates at shared-nginx; see docs/deploy-vm.md.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
  /**
   * Where `reconciliation-ingest` answers — 2026-07-28 ingestion spec section 4.
   *
   * Defaulted rather than required because `next build` and the unit suite never
   * call the service, and making this mandatory would turn a working build into
   * a failing one for a variable neither of them reads. That is not a licence to
   * leave it unset in a deployment: an upload whose parse job cannot be started
   * is refused outright (section 7), so a wrong value here surfaces as a refusal
   * naming the service rather than as a workbook quietly accepted and unparsed.
   *
   * On the shared network the service binds no host port and is reached as
   * `http://reconciliation-ingest:8006`; the default below is the local uvicorn.
   *
   * 8006 rather than the 8005 the port registry would have handed out next:
   * 8005 sits in a Windows reserved port-exclusion range on the developer
   * machines here, so uvicorn fails to bind with a permissions error that reads
   * like a firewall problem. The service standardises on 8006 everywhere so the
   * container and the local run cannot disagree.
   */
  INGEST_URL: z.string().min(1).default('http://127.0.0.1:8006'),
  /**
   * The shared secret sent as `X-Ingest-Token` — spec section 8.
   *
   * Deliberately NOT `NEXT_PUBLIC_`: Next inlines every `NEXT_PUBLIC_` value
   * into the client bundle, and this token is the only thing standing between
   * shared-network and a service that reads the storage volume. It must reach
   * the browser through nothing, which is why the job poll goes through a Route
   * Handler instead of the browser calling the service directly.
   *
   * The default is a placeholder the service rejects. That is intentional: a
   * rejected token returns 404 (section 8 — the service does not confirm its own
   * existence to an unauthenticated caller), which the client turns into the
   * same refusal as the service being down. Silently succeeding with a wrong
   * secret would be the worse failure.
   */
  INGEST_TOKEN: z.string().min(1).default('local-dev-ingest-token-change-me'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
