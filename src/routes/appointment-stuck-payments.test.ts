import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

function dateKey(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

describe('stuck payment recovery', () => {
  let doctorId: string;
  let patientId: string;
  let suffix: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'Stuck Admin', email: `stuck-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Stuck Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: { name: 'Stuck Doctor', email: `stuck-doctor-${suffix}@test.com` },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Stuck',
        consultationFee: 90,
        approvalStatus: 'APPROVED',
      },
    });

    for (let weekday = 0; weekday < 7; weekday++) {
      await prisma.availability.create({
        data: {
          doctorId: doctor.id,
          weekday,
          startTime: '00:00',
          endTime: '23:30',
          slotDurationMin: 30,
          bufferMin: 0,
        },
      });
    }

    const patient = await prisma.user.create({
      data: {
        name: 'Stuck Patient',
        email: `stuck-patient-${suffix}@test.com`,
      },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  it('releases a booking whose checkout session expired unpaid', async () => {
    const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'PENDING_PAYMENT',
      },
    });
    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: `cs_test_${suffix}`,
        amount: 90,
        status: 'PENDING',
      },
    });

    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: null,
    } as never);

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/sync-payment`,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(payment.status).toBe('FAILED');
  });

  it('frees the slot when Stripe fails to create the checkout session', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });

    const availability = await request(app).get(
      `/api/doctors/${doctorId}/availability?from=${dateKey(1)}&to=${dateKey(2)}`,
    );
    const slotStart: string = availability.body.flatMap(
      (day: { slots: { start: string }[] }) => day.slots,
    )[0].start;

    vi.mocked(stripe.checkout.sessions.create).mockRejectedValueOnce(
      new Error('stripe unavailable'),
    );

    const failed = await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart });

    expect(failed.status).toBe(500);
    expect(
      await prisma.appointment.count({
        where: { doctorId, status: 'PENDING_PAYMENT' },
      }),
    ).toBe(0);

    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
      id: `cs_test_${suffix}`,
      url: 'https://checkout.stripe.com/retry',
    } as never);

    const retry = await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart });

    expect(retry.status).toBe(201);
  });
});
