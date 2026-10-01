import { config } from 'dotenv';
config({ path: '.env.test', override: true });

import { afterAll, vi } from 'vitest';

vi.mock('./src/lib/stripe.js', () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
    refunds: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
}));

vi.mock('./src/lib/resend.js', () => ({
  resend: {
    emails: {
      send: vi.fn().mockResolvedValue({ data: { id: 'test' }, error: null }),
    },
  },
}));

afterAll(async () => {
  const { prisma } = await import('./src/lib/prisma.js');

  await prisma.$transaction([
    prisma.payment.deleteMany(),
    prisma.appointment.deleteMany(),
    prisma.availabilityException.deleteMany(),
    prisma.availability.deleteMany(),
    prisma.doctor.deleteMany(),
    prisma.clinic.deleteMany(),
    prisma.session.deleteMany(),
    prisma.account.deleteMany(),
    prisma.user.deleteMany(),
  ]);
  await prisma.$disconnect();
});
