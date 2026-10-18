import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt, bearer } from 'better-auth/plugins';
import { sendPasswordResetEmail } from '../services/email.service.js';
import { prisma } from './prisma.js';

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [process.env.CLIENT_URL ?? 'http://localhost:3000'],
  advanced: {
    // Better Auth skips redirect URL validation when NODE_ENV is "test"; keep it on so tests match production.
    disableOriginCheck: false,
  },
  emailAndPassword: {
    enabled: true,
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  plugins: [jwt(), bearer()],
});