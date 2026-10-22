import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

const HOUR = 60 * 60 * 1000;

describe('cross-user access', () => {
  const ids = {
    doctorBUserId: '',
    strangerId: '',
    futureAppointmentId: '',
    pastAppointmentId: '',
    availabilityId: '',
    exceptionId: '',
  };
  let futureSlotStart = new Date();

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'Idor Admin', email: `idor-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Idor Clinic',
        address: '1 Idor Road',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });

    async function createDoctor(label: string) {
      const user = await prisma.user.create({
        data: {
          name: `Idor Doctor ${label}`,
          email: `idor-doctor-${label}-${suffix}@test.com`,
          role: 'DOCTOR',
        },
      });
      const doctor = await prisma.doctor.create({
        data: {
          userId: user.id,
          clinicId: clinic.id,
          specialty: 'Idor',
          consultationFee: 20,
          approvalStatus: 'APPROVED',
        },
      });

      return { user, doctor };
    }

    const doctorA = await createDoctor('a');
    const doctorB = await createDoctor('b');

    const owner = await prisma.user.create({
      data: { name: 'Idor Owner', email: `idor-owner-${suffix}@test.com` },
    });
    const stranger = await prisma.user.create({
      data: {
        name: 'Idor Stranger',
        email: `idor-stranger-${suffix}@test.com`,
      },
    });

    futureSlotStart = new Date(Date.now() + 48 * HOUR);
    const future = await prisma.appointment.create({
      data: {
        doctorId: doctorA.doctor.id,
        patientId: owner.id,
        slotStart: futureSlotStart,
        slotEnd: new Date(futureSlotStart.getTime() + 30 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    const pastStart = new Date(Date.now() - 3 * HOUR);
    const past = await prisma.appointment.create({
      data: {
        doctorId: doctorA.doctor.id,
        patientId: owner.id,
        slotStart: pastStart,
        slotEnd: new Date(pastStart.getTime() + 30 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    const rule = await prisma.availability.create({
      data: {
        doctorId: doctorA.doctor.id,
        weekday: 1,
        startTime: '09:00',
        endTime: '12:00',
        slotDurationMin: 30,
        bufferMin: 0,
      },
    });

    const exception = await prisma.availabilityException.create({
      data: {
        doctorId: doctorA.doctor.id,
        date: new Date(
          new Date(Date.now() + 30 * 24 * HOUR).toISOString().slice(0, 10),
        ),
        isBlocked: true,
      },
    });

    ids.doctorBUserId = doctorB.user.id;
    ids.strangerId = stranger.id;
    ids.futureAppointmentId = future.id;
    ids.pastAppointmentId = past.id;
    ids.availabilityId = rule.id;
    ids.exceptionId = exception.id;
  }, 120_000);

  function asDoctorB() {
    setTestUser({
      id: ids.doctorBUserId,
      role: 'DOCTOR',
      doctorApprovalStatus: 'APPROVED',
    });
  }

  it("blocks another patient from rescheduling someone else's appointment", async () => {
    setTestUser({ id: ids.strangerId, role: 'PATIENT' });

    const response = await request(app)
      .patch(`/api/appointments/${ids.futureAppointmentId}/reschedule`)
      .send({ slotStart: new Date(Date.now() + 72 * HOUR).toISOString() });

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: ids.futureAppointmentId },
    });

    expect(response.status).toBe(403);
    expect(row.status).toBe('BOOKED');
    expect(row.slotStart.getTime()).toBe(futureSlotStart.getTime());
  });

  it("keeps a doctor from updating another doctor's appointment", async () => {
    asDoctorB();

    const response = await request(app)
      .patch(`/api/doctors/me/appointments/${ids.pastAppointmentId}/status`)
      .send({ status: 'COMPLETED' });

    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id: ids.pastAppointmentId },
    });

    expect(response.status).toBe(404);
    expect(row.status).toBe('BOOKED');
  });

  it("keeps a doctor from deleting another doctor's leave day", async () => {
    asDoctorB();

    const response = await request(app).delete(
      `/api/doctors/me/exceptions/${ids.exceptionId}`,
    );

    expect(response.status).toBe(404);
    expect(
      await prisma.availabilityException.count({
        where: { id: ids.exceptionId },
      }),
    ).toBe(1);
  });

  it("lists only the signed-in doctor's own availability and leave days", async () => {
    asDoctorB();

    const rules = await request(app).get('/api/doctors/me/availability');
    const leave = await request(app).get('/api/doctors/me/exceptions');

    expect(JSON.stringify(rules.body)).not.toContain(ids.availabilityId);
    expect(JSON.stringify(leave.body)).not.toContain(ids.exceptionId);
  });

  it('keeps patients out of the doctor portal and anonymous visitors out of everything private', async () => {
    setTestUser({ id: ids.strangerId, role: 'PATIENT' });
    const asPatient = await request(app).get('/api/doctors/me/appointments');

    setTestUser(null);
    const anonymousPortal = await request(app).get(
      '/api/doctors/me/appointments',
    );
    const anonymousAppointment = await request(app).get(
      `/api/appointments/${ids.futureAppointmentId}`,
    );

    expect(asPatient.status).toBe(403);
    expect(anonymousPortal.status).toBe(401);
    expect(anonymousAppointment.status).toBe(401);
  });
});
