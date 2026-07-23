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
      secure: process.env.NODE_ENV === 'production',
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
      isActive: { type: 'boolean', required: false, input: false, defaultValue: true },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
