import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@/db/client';
import * as schema from '@/db/schema';
import { env } from '@/lib/env';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Additive: Better Auth already trusts the origin of baseURL. This covers the
  // OTHER hostnames the same deployment answers on — the VM's bare IP alongside
  // the domain in front of it — because a sign-in from an unlisted origin is
  // rejected as INVALID_ORIGIN and surfaces to the user as a wrong password.
  // See TRUSTED_ORIGINS in src/lib/env.ts.
  trustedOrigins: env.TRUSTED_ORIGINS,
  emailAndPassword: {
    enabled: true,
    // No public registration. Accounts are created by an admin, or by the
    // first-run setup script.
    disableSignUp: true,
    minPasswordLength: 12,
  },
  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      // Driven by COOKIE_SECURE (default true) rather than by NODE_ENV, because
      // the two questions are different: NODE_ENV asks "is this a production
      // build", and this asks "is this origin HTTPS". On the shared VM the
      // answer is yes to the first and no to the second, and tying them
      // together produced a production build whose session cookie the browser
      // would never send back. See src/lib/env.ts for why that is a known gap.
      secure: env.COOKIE_SECURE,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 5,
  },
  user: {
    additionalFields: {
      // input: false is a security control, not a typing detail — it stops
      // these fields being set from a request payload, so nobody can
      // self-assign admin through sign-up or a profile update.
      role: { type: 'string', required: false, input: false, defaultValue: 'sales' },
      smId: { type: 'string', required: false, input: false },
      // Same `input: false` reasoning as `role` and `smId`, and it matters more
      // here, not less: a self-assigned tlCode would make an account the approver
      // for a team it has nothing to do with.
      tlCode: { type: 'string', required: false, input: false },
      acmCode: { type: 'string', required: false, input: false },
      isActive: { type: 'boolean', required: false, input: false, defaultValue: true },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
