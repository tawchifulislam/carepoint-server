import { config } from 'dotenv';
config({ path: '.env.test', override: true });

import { afterAll, vi } from 'vitest';

vi.mock('./src/lib/stripe.js', () => ({
  stripe: {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
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

  await prisma.payment.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.availabilityException.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.doctor.deleteMany();
  await prisma.clinic.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();

  await prisma.$disconnect();
});
