import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().min(1),
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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
