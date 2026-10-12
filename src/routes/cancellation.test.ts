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

const HOUR = 60 * 60 * 1000;

describe('appointment cancellation', () => {
  let doctorUserId: string;
  let doctorId: string;
  let otherDoctorUserId: string;
  let patientId: string;
  let patientEmail: string;
  let suffix: string;
  let counter = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    patientEmail = `cancel-patient-${suffix}@test.com`;

    const admin = await prisma.user.create({
      data: { name: 'Cancel Admin', email: `cancel-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Cancel Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });

    const doctorUser = await prisma.user.create({
      data: {
        name: 'Cancel Doctor',
        email: `cancel-doctor-${suffix}@test.com`,
        role: 'DOCTOR',
      },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Cancel',
        consultationFee: 65,
        approvalStatus: 'APPROVED',
      },
    });

    const otherUser = await prisma.user.create({
      data: {
        name: 'Other Cancel Doctor',
        email: `cancel-other-${suffix}@test.com`,
        role: 'DOCTOR',
      },
    });
    await prisma.doctor.create({
      data: {
        userId: otherUser.id,
        clinicId: clinic.id,
        specialty: 'Other',
        consultationFee: 65,
        approvalStatus: 'APPROVED',
      },
    });

    const patient = await prisma.user.create({
      data: { name: 'Cancel Patient', email: patientEmail },
    });

    doctorUserId = doctorUser.id;
    doctorId = doctor.id;
    otherDoctorUserId = otherUser.id;
    patientId = patient.id;
  });

  async function createBooked(options: {
    hoursFromNow: number;
    withPayment?: boolean;
    status?: 'BOOKED' | 'COMPLETED';
  }) {
    counter += 1;
    const slotStart = new Date(
      Date.now() + options.hoursFromNow * HOUR + counter * 60_000,
    );

    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: options.status ?? 'BOOKED',
      },
    });

    if (options.withPayment !== false) {
      await prisma.payment.create({
        data: {
          appointment: { connect: { id: appointment.id } },
          stripePaymentIntentId: `pi_cancel_${suffix}_${counter}`,
          amount: 65,
          status: 'SUCCEEDED',
        },
      });
    }

    return appointment;
  }

  function asDoctor() {
    setTestUser({
      id: doctorUserId,
      role: 'DOCTOR',
      doctorApprovalStatus: 'APPROVED',
    });
  }

  async function statusOf(appointmentId: string) {
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
    });
    return row.status;
  }

  it('lets a doctor cancel, refunds the payment, and emails the patient', async () => {
    const appointment = await createBooked({ hoursFromNow: 24 });
    asDoctor();
    vi.mocked(stripe.refunds.create).mockResolvedValue({} as never);

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(200);
    expect(response.body.refunded).toBe(true);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: `pi_cancel_${suffix}_${counter}` },
      { idempotencyKey: `refund-${appointment.id}` },
    );
    expect(await statusOf(appointment.id)).toBe('CANCELLED');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(payment.status).toBe('REFUNDED');

    expect(resend.emails.send).toHaveBeenCalledTimes(1);
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: patientEmail }),
    );
  });

  it('keeps the appointment booked when the refund fails', async () => {
    const appointment = await createBooked({ hoursFromNow: 24 });
    asDoctor();
    vi.mocked(stripe.refunds.create).mockRejectedValue(
      new Error('stripe unavailable'),
    );

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(502);
    expect(await statusOf(appointment.id)).toBe('BOOKED');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { appointmentId: appointment.id },
    });
    expect(payment.status).toBe('SUCCEEDED');
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it('treats an already refunded charge as a successful refund', async () => {
    const appointment = await createBooked({ hoursFromNow: 24 });
    asDoctor();
    vi.mocked(stripe.refunds.create).mockRejectedValue(
      Object.assign(new Error('Charge already refunded'), {
        code: 'charge_already_refunded',
      }),
    );

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(200);
    expect(await statusOf(appointment.id)).toBe('CANCELLED');
  });

  it('cancels an appointment that has no payment record without calling Stripe', async () => {
    const appointment = await createBooked({
      hoursFromNow: 24,
      withPayment: false,
    });
    asDoctor();

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(200);
    expect(response.body.refunded).toBe(false);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("does not let a doctor cancel another doctor's appointment", async () => {
    const appointment = await createBooked({ hoursFromNow: 24 });
    setTestUser({
      id: otherDoctorUserId,
      role: 'DOCTOR',
      doctorApprovalStatus: 'APPROVED',
    });

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(404);
    expect(await statusOf(appointment.id)).toBe('BOOKED');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('refuses to cancel an appointment that already started', async () => {
    const appointment = await createBooked({ hoursFromNow: -1 });
    asDoctor();

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(400);
    expect(await statusOf(appointment.id)).toBe('BOOKED');
  });

  it('refuses to cancel an appointment that is not booked', async () => {
    const appointment = await createBooked({
      hoursFromNow: 24,
      status: 'COMPLETED',
    });
    asDoctor();

    const response = await request(app).patch(
      `/api/doctors/me/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(409);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('does not cancel a patient booking when their refund fails', async () => {
    const appointment = await createBooked({ hoursFromNow: 6 });
    setTestUser({ id: patientId, role: 'PATIENT' });
    vi.mocked(stripe.refunds.create).mockRejectedValue(
      new Error('stripe unavailable'),
    );

    const response = await request(app).patch(
      `/api/appointments/${appointment.id}/cancel`,
    );

    expect(response.status).toBe(502);
    expect(await statusOf(appointment.id)).toBe('BOOKED');
  });
});
