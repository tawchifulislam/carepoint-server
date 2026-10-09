import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resend } from '../lib/resend.js';
import { stripe } from '../lib/stripe.js';
import { sweepStalePendingPayments } from './payment-sweep.service.js';

let counter = 0;

describe('stale payment sweep', () => {
  let doctorId: string;
  let patientId: string;
  let suffix: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'Sweep Admin', email: `sweep-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Sweep Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: { name: 'Sweep Doctor', email: `sweep-doctor-${suffix}@test.com` },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Sweep',
        consultationFee: 55,
        approvalStatus: 'APPROVED',
      },
    });
    const patient = await prisma.user.create({
      data: {
        name: 'Sweep Patient',
        email: `sweep-patient-${suffix}@test.com`,
      },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  async function createPending(options: {
    ageMinutes: number;
    withPayment: boolean;
  }) {
    counter += 1;
    const slotStart = new Date(Date.now() + (24 + counter) * 60 * 60 * 1000);
    const sessionId = `cs_test_${suffix}_${counter}`;

    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'PENDING_PAYMENT',
        createdAt: new Date(Date.now() - options.ageMinutes * 60 * 1000),
      },
    });

    if (options.withPayment) {
      await prisma.payment.create({
        data: {
          appointment: { connect: { id: appointment.id } },
          stripePaymentIntentId: sessionId,
          amount: 55,
          status: 'PENDING',
        },
      });
    }

    return { appointment, sessionId };
  }

  async function statusOf(appointmentId: string) {
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
    });
    return row.status;
  }

  it('releases a stale booking whose checkout session expired unpaid', async () => {
    const { appointment } = await createPending({
      ageMinutes: 40,
      withPayment: true,
    });
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: null,
    } as never);

    const result = await sweepStalePendingPayments();

    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(await statusOf(appointment.id)).toBe('CANCELLED');
  });

  it('confirms a stale booking that was actually paid and emails the patient once', async () => {
    const { appointment } = await createPending({
      ageMinutes: 40,
      withPayment: true,
    });
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_sweep_${suffix}`,
    } as never);

    const result = await sweepStalePendingPayments();

    expect(result.confirmed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(appointment.id)).toBe('BOOKED');
    expect(resend.emails.send).toHaveBeenCalledTimes(1);
  });

  it('releases a stale booking that has no payment record', async () => {
    const { appointment } = await createPending({
      ageMinutes: 40,
      withPayment: false,
    });

    await sweepStalePendingPayments();

    expect(await statusOf(appointment.id)).toBe('CANCELLED');
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('leaves a recent pending booking alone', async () => {
    const { appointment } = await createPending({
      ageMinutes: 10,
      withPayment: true,
    });

    await sweepStalePendingPayments();

    expect(await statusOf(appointment.id)).toBe('PENDING_PAYMENT');
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED' },
    });
  });

  it('keeps sweeping when Stripe fails for one booking', async () => {
    const failing = await createPending({ ageMinutes: 40, withPayment: true });
    const healthy = await createPending({ ageMinutes: 40, withPayment: true });

    vi.mocked(stripe.checkout.sessions.retrieve).mockImplementation((async (
      sessionId: string,
    ) => {
      if (sessionId === failing.sessionId) {
        throw new Error('stripe unavailable');
      }
      return {
        status: 'expired',
        payment_status: 'unpaid',
        payment_intent: null,
      };
    }) as never);

    const result = await sweepStalePendingPayments();

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(healthy.appointment.id)).toBe('CANCELLED');
    expect(await statusOf(failing.appointment.id)).toBe('PENDING_PAYMENT');

    await prisma.appointment.update({
      where: { id: failing.appointment.id },
      data: { status: 'CANCELLED' },
    });
  });
});
