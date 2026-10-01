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

function mockCheckoutSession() {
  vi.mocked(stripe.checkout.sessions.create).mockImplementation(
    async () =>
      ({
        id: `cs_test_${Math.random().toString(36).slice(2)}`,
        url: 'https://checkout.stripe.com/test',
      }) as never,
  );
}

describe('appointment routes', () => {
  let doctorId: string;
  let doctorUserId: string;
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
    doctorUserId = doctorUser.id;
    patientId = patient.id;
  });

  async function firstAvailableSlot(): Promise<string> {
    const from = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const response = await request(app).get(
      `/api/doctors/${doctorId}/availability?from=${from}&to=${to}`,
    );
    const slot = response.body.flatMap(
      (d: { slots: { start: string }[] }) => d.slots,
    )[0];
    return slot.start;
  }

  it('creates an appointment and starts a checkout session', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });
    mockCheckoutSession();

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
    mockCheckoutSession();

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

  it('reschedules a booked appointment to a new slot', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });
    mockCheckoutSession();

    const slotStart = await firstAvailableSlot();
    const created = await request(app)
      .post('/api/appointments')
      .send({ doctorId, slotStart });
    await prisma.appointment.update({
      where: { id: created.body.appointment.id },
      data: { status: 'BOOKED' },
    });

    const newSlot = new Date(
      new Date(slotStart).getTime() + 60 * 60 * 1000,
    ).toISOString();

    const response = await request(app)
      .patch(`/api/appointments/${created.body.appointment.id}/reschedule`)
      .send({ slotStart: newSlot });

    expect(response.status).toBe(200);
    expect(response.body.slotStart).toBe(newSlot);
    expect(response.body.id).not.toBe(created.body.appointment.id);
  });

  it('blocks rescheduling within the 2 hour cutoff', async () => {
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(Date.now() + 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 1.5 * 60 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app)
      .patch(`/api/appointments/${appointment.id}/reschedule`)
      .send({
        slotStart: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
      });

    expect(response.status).toBe(400);
  });

  it('rejects rescheduling to a slot that is not available', async () => {
    const otherPatient = await prisma.user.create({
      data: {
        name: 'Other Patient',
        email: `other-patient-${Date.now()}@test.com`,
      },
    });
    const appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(Date.now() + 5 * 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        status: 'BOOKED',
      },
    });
    const takenSlot = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await prisma.appointment.create({
      data: {
        doctorId,
        patientId: otherPatient.id,
        slotStart: takenSlot,
        slotEnd: new Date(takenSlot.getTime() + 30 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app)
      .patch(`/api/appointments/${appointment.id}/reschedule`)
      .send({ slotStart: takenSlot.toISOString() });

    expect(response.status).toBe(409);
  });

  describe('get by id ownership', () => {
    let appointmentId: string;

    beforeEach(async () => {
      const appointment = await prisma.appointment.create({
        data: {
          doctorId,
          patientId,
          slotStart: new Date(Date.now() + 4 * 60 * 60 * 1000),
          slotEnd: new Date(Date.now() + 4.5 * 60 * 60 * 1000),
          status: 'BOOKED',
        },
      });
      appointmentId = appointment.id;
    });

    it('lets the owning patient view it', async () => {
      setTestUser({ id: patientId, role: 'PATIENT' });
      const response = await request(app).get(
        `/api/appointments/${appointmentId}`,
      );
      expect(response.status).toBe(200);
    });

    it('lets the treating doctor view it', async () => {
      setTestUser({ id: doctorUserId, role: 'DOCTOR' });
      const response = await request(app).get(
        `/api/appointments/${appointmentId}`,
      );
      expect(response.status).toBe(200);
    });

    it('lets a super admin view it', async () => {
      setTestUser({ id: 'any-super-admin', role: 'SUPER_ADMIN' });
      const response = await request(app).get(
        `/api/appointments/${appointmentId}`,
      );
      expect(response.status).toBe(200);
    });

    it('blocks an unrelated patient from viewing it', async () => {
      setTestUser({ id: 'some-stranger', role: 'PATIENT' });
      const response = await request(app).get(
        `/api/appointments/${appointmentId}`,
      );
      expect(response.status).toBe(403);
    });
  });

  it("paginates the patient's appointment list", async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.appointment.create({
        data: {
          doctorId,
          patientId,
          slotStart: new Date(Date.now() + (i + 1) * 60 * 60 * 1000),
          slotEnd: new Date(Date.now() + (i + 1.5) * 60 * 60 * 1000),
          status: 'BOOKED',
        },
      });
    }

    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app).get(
      '/api/appointments/me?page=1&pageSize=2',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.total).toBe(3);
    expect(response.body.totalPages).toBe(2);
  });
});
