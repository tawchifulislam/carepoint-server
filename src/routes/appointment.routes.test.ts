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

function futureDateKey(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

describe('appointment routes', () => {
  let doctorId: string;
  let patientId: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    const clinicAdmin = await prisma.user.create({
      data: { name: 'Test Admin', email: `admin-${Date.now()}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Test Clinic',
        address: 'Somewhere',
        adminUserId: clinicAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: { name: 'Test Doctor', email: `doctor-${Date.now()}@test.com` },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Testing',
        consultationFee: 100,
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
      data: { name: 'Test Patient', email: `patient-${Date.now()}@test.com` },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  async function firstAvailableSlot(): Promise<string> {
    const response = await request(app).get(
      `/api/doctors/${doctorId}/availability?from=${futureDateKey(1)}&to=${futureDateKey(3)}`,
    );
    const slot = response.body.flatMap(
      (d: { slots: { start: string }[] }) => d.slots,
    )[0];
    return slot.start;
  }

  it('creates an appointment and starts a checkout session', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.checkout.sessions.create).mockImplementation(
      async () =>
        ({
          id: `cs_test_${Math.random().toString(36).slice(2)}`,
          url: 'https://checkout.stripe.com/test',
        }) as never,
    );

    const slotStart = await firstAvailableSlot();

    const response = await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart });

    expect(response.status).toBe(201);
    expect(response.body.checkoutUrl).toBe('https://checkout.stripe.com/test');
    expect(response.body.appointment.status).toBe('PENDING_PAYMENT');
  });

  it('rejects a slot that is already taken', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.checkout.sessions.create).mockImplementation(
      async () =>
        ({
          id: `cs_test_${Math.random().toString(36).slice(2)}`,
          url: 'https://checkout.stripe.com/test',
        }) as never,
    );

    const slotStart = await firstAvailableSlot();

    await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart })
      .expect(201);
    const second = await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart });

    expect(second.status).toBe(409);
  });

  it("blocks cancelling someone else's appointment", async () => {
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(Date.now() + 3 * 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 3.5 * 60 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    setTestUser({ id: 'someone-else', role: 'PATIENT' });

    const response = await request(app).patch(
      `/api/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(403);
  });

  it('refunds a paid appointment on cancel, and blocks a second cancel', async () => {
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(Date.now() + 3 * 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 3.5 * 60 * 60 * 1000),
        status: 'BOOKED',
      },
    });
    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: 'pi_test_123',
        amount: 100,
        status: 'SUCCEEDED',
      },
    });

    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.refunds.create).mockResolvedValue({} as never);

    const first = await request(app).patch(
      `/api/appointments/${appointment.id}/cancel`,
    );
    expect(first.status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledWith({
      payment_intent: 'pi_test_123',
    });

    const second = await request(app).patch(
      `/api/appointments/${appointment.id}/cancel`,
    );
    expect(second.status).toBe(409);
  });
});
