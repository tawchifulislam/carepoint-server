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

describe('resume payment and hold expiry', () => {
  let doctorId: string;
  let patientId: string;
  let suffix: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'Resume Admin', email: `resume-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Resume Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: {
        name: 'Resume Doctor',
        email: `resume-doctor-${suffix}@test.com`,
      },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Resume',
        consultationFee: 70,
        approvalStatus: 'APPROVED',
      },
    });
    const patient = await prisma.user.create({
      data: {
        name: 'Resume Patient',
        email: `resume-patient-${suffix}@test.com`,
      },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  async function createAppointment(status: 'PENDING_PAYMENT' | 'BOOKED') {
    const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status,
      },
    });
    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: `cs_test_${suffix}`,
        amount: 70,
        status: 'PENDING',
      },
    });

    return appointment;
  }

  it('returns the existing checkout URL for the owner of a pending appointment', async () => {
    const appointment = await createAppointment('PENDING_PAYMENT');
    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'open',
      url: 'https://checkout.stripe.com/resume',
    } as never);

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/resume-payment`,
    );

    expect(response.status).toBe(200);
    expect(response.body.checkoutUrl).toBe(
      'https://checkout.stripe.com/resume',
    );
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
      `cs_test_${suffix}`,
    );
  });

  it('rejects resuming when the Stripe session has expired', async () => {
    const appointment = await createAppointment('PENDING_PAYMENT');
    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      status: 'expired',
      url: null,
    } as never);

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/resume-payment`,
    );

    expect(response.status).toBe(409);
  });

  it('blocks another user from resuming payment', async () => {
    const appointment = await createAppointment('PENDING_PAYMENT');
    setTestUser({ id: 'someone-else', role: 'PATIENT' });

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/resume-payment`,
    );

    expect(response.status).toBe(403);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('rejects resuming an appointment that is already booked', async () => {
    const appointment = await createAppointment('BOOKED');
    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app).post(
      `/api/appointments/${appointment.id}/resume-payment`,
    );

    expect(response.status).toBe(409);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('reports a hold expiry only while the appointment awaits payment', async () => {
    const pending = await createAppointment('PENDING_PAYMENT');
    setTestUser({ id: patientId, role: 'PATIENT' });

    const pendingResponse = await request(app).get(
      `/api/appointments/${pending.id}`,
    );

    expect(pendingResponse.status).toBe(200);
    expect(new Date(pendingResponse.body.holdExpiresAt).getTime()).toBe(
      pending.createdAt.getTime() + 30 * 60 * 1000,
    );

    await prisma.appointment.update({
      where: { id: pending.id },
      data: { status: 'BOOKED' },
    });

    const bookedResponse = await request(app).get(
      `/api/appointments/${pending.id}`,
    );

    expect(bookedResponse.body.holdExpiresAt).toBeNull();
  });
});
