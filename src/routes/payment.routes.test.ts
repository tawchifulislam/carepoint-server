import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { resend } from '../lib/resend.js';

function mockEvent(type: string, data: Record<string, unknown>) {
  vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
    type,
    data: { object: data },
  } as never);
}

describe('stripe webhook', () => {
  let doctorId: string;
  let patientId: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    const clinicAdmin = await prisma.user.create({
      data: { name: 'Webhook Admin', email: `wh-admin-${Date.now()}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Webhook Clinic',
        address: 'Somewhere',
        adminUserId: clinicAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: {
        name: 'Webhook Doctor',
        email: `wh-doctor-${Date.now()}@test.com`,
      },
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
    const patient = await prisma.user.create({
      data: {
        name: 'Webhook Patient',
        email: `wh-patient-${Date.now()}@test.com`,
      },
    });

    doctorId = doctor.id;
    patientId = patient.id;
  });

  async function createPendingAppointment() {
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(Date.now() + 3 * 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 3.5 * 60 * 60 * 1000),
        status: 'PENDING_PAYMENT',
      },
    });
    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: `cs_test_${appointment.id}`,
        amount: 100,
        status: 'PENDING',
      },
    });
    return appointment;
  }

  function post() {
    return request(app)
      .post('/api/payments/webhook')
      .set('stripe-signature', 'test')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
  }

  it('rejects a request with no signature header', async () => {
    const response = await request(app)
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(response.status).toBe(400);
  });

  it('rejects a request with an invalid signature', async () => {
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => {
      throw new Error('bad signature');
    });

    const response = await post();

    expect(response.status).toBe(400);
  });

  it('confirms booking and sends a confirmation email on checkout.session.completed', async () => {
    const appointment = await createPendingAppointment();
    mockEvent('checkout.session.completed', {
      metadata: { appointmentId: appointment.id },
      payment_intent: `pi_real_${appointment.id}`,
    });

    const response = await post();

    expect(response.status).toBe(200);
    const updated = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(updated.status).toBe('BOOKED');
    expect(resend.emails.send).toHaveBeenCalledTimes(1);
  });

  it('does not re-send confirmation email on a duplicate completed event', async () => {
    const appointment = await createPendingAppointment();
    mockEvent('checkout.session.completed', {
      metadata: { appointmentId: appointment.id },
      payment_intent: `pi_real_${appointment.id}`,
    });

    await post();
    await post();

    expect(resend.emails.send).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending appointment on checkout.session.expired', async () => {
    const appointment = await createPendingAppointment();
    mockEvent('checkout.session.expired', {
      metadata: { appointmentId: appointment.id },
    });

    await post();

    const updated = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(updated.status).toBe('CANCELLED');
  });

  it('ignores an out-of-order expired event for an already booked appointment', async () => {
    const appointment = await createPendingAppointment();

    mockEvent('checkout.session.completed', {
      metadata: { appointmentId: appointment.id },
      payment_intent: `pi_real_${appointment.id}`,
    });
    await post();

    mockEvent('checkout.session.expired', {
      metadata: { appointmentId: appointment.id },
    });
    await post();

    const updated = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(updated.status).toBe('BOOKED');
  });
});
