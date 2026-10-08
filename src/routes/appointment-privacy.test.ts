import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

describe('appointment response privacy', () => {
  let patientId: string;
  let appointmentId: string;
  let doctorEmail: string;

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    doctorEmail = `privacy-doctor-${suffix}@test.com`;

    const admin = await prisma.user.create({
      data: {
        name: 'Privacy Admin',
        email: `privacy-admin-${suffix}@test.com`,
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Privacy Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: { name: 'Privacy Doctor', email: doctorEmail },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'Privacy',
        consultationFee: 60,
        approvalStatus: 'APPROVED',
      },
    });
    const patient = await prisma.user.create({
      data: {
        name: 'Privacy Patient',
        email: `privacy-patient-${suffix}@test.com`,
      },
    });

    const appointment = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        slotStart: new Date(Date.now() + 5 * 60 * 60 * 1000),
        slotEnd: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        status: 'BOOKED',
      },
    });
    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: `pi_privacy_${suffix}`,
        amount: 60,
        status: 'SUCCEEDED',
      },
    });

    patientId = patient.id;
    appointmentId = appointment.id;
  });

  it('keeps the doctor email and payment details out of the patient list', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app).get('/api/appointments/me');

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(doctorEmail);
    expect(body).not.toContain('pi_privacy_');
    expect(response.body.data[0].doctor.user).toEqual({
      name: 'Privacy Doctor',
    });
  });

  it('keeps the doctor email and payment details out of the detail view', async () => {
    setTestUser({ id: patientId, role: 'PATIENT' });

    const response = await request(app).get(
      `/api/appointments/${appointmentId}`,
    );

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(doctorEmail);
    expect(body).not.toContain('pi_privacy_');
    expect(response.body.doctorId).toBeTypeOf('string');
  });
});
