import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { resend } from '../lib/resend.js';
import { stripe } from '../lib/stripe.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

describe('sync payment', () => {
  let doctorId: string;
  let patientId: string;
  let suffix: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'Sync Admin', email: `sync-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Sync Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: { name: 'Sync Doctor', email: `sync-doctor-${suffix}@test.com` },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Sync',
        consultationFee: 80,
        approvalStatus: 'APPROVED',
      },
    });
    const patient = await prisma.user.create({
      data: { name: 'Sync Patient', email: `sync-patient-${suffix}@test.com` },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  async function createPendingAppointment() {
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
        amount: 80,
        status: 'PENDING',
      },
    });

    return appointment;
  }

  function mockSession(overrides: Record<string, unknown> = {}) {
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_sync_${suffix}`,
      ...overrides,
    } as never);
  }

  it('confirms a paid session that the webhook never reported', async () => {
    const appointment = await createPendingAppointment();
    setTestUser({ id: patientId, role: 'PATIENT' });
    mockSession();

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/sync-payment`,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('BOOKED');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.stripePaymentIntentId).toBe(`pi_sync_${suffix}`);
    expect(resend.emails.send).toHaveBeenCalledTimes(1);
  });

  it('does not ask Stripe or send a second email when synced again', async () => {
    const appointment = await createPendingAppointment();
    setTestUser({ id: patientId, role: 'PATIENT' });
    mockSession();

    await request(app).post(`/api/appointments/${appointment.id}/sync-payment`);
    const second = await request(app).post(
      `/api/appointments/${appointment.id}/sync-payment`,
    );

    expect(second.body.status).toBe('BOOKED');
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
    expect(resend.emails.send).toHaveBeenCalledTimes(1);
  });

  it('leaves an unpaid session pending', async () => {
    const appointment = await createPendingAppointment();
    setTestUser({ id: patientId, role: 'PATIENT' });
    mockSession({
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
    });

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/sync-payment`,
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('PENDING_PAYMENT');
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it("blocks syncing someone else's appointment", async () => {
    const appointment = await createPendingAppointment();
    setTestUser({ id: 'someone-else', role: 'PATIENT' });

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/sync-payment`,
    );

    expect(response.status).toBe(403);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});
