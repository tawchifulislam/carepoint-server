import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
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

describe('doctor routes', () => {
  let clinicId: string;
  let doctorUserId: string;
  let doctorId: string;

  beforeEach(async () => {
    setTestUser(null);

    const clinicAdmin = await prisma.user.create({
      data: {
        name: 'Doc Clinic Admin',
        email: `doc-admin-${Date.now()}@test.com`,
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Searchable Clinic',
        address: 'Somewhere',
        adminUserId: clinicAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });
    const doctorUser = await prisma.user.create({
      data: {
        name: 'Searchable Doctor',
        email: `doc-user-${Date.now()}@test.com`,
      },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'UniqueSpecialtyXyz',
        consultationFee: 100,
        approvalStatus: 'APPROVED',
      },
    });

    clinicId = clinic.id;
    doctorUserId = doctorUser.id;
    doctorId = doctor.id;
  });

  describe('public listing', () => {
    it('finds the doctor by specialty search', async () => {
      const response = await request(app).get(
        '/api/doctors?search=UniqueSpecialtyXyz',
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(doctorId);
    });

    it('hides a doctor whose clinic is not approved', async () => {
      const pendingAdmin = await prisma.user.create({
        data: {
          name: 'Pending Admin',
          email: `pending-admin-${Date.now()}@test.com`,
        },
      });
      const pendingClinic = await prisma.clinic.create({
        data: {
          name: 'Pending Clinic',
          address: 'Nowhere',
          adminUserId: pendingAdmin.id,
          approvalStatus: 'PENDING',
        },
      });
      const hiddenDoctorUser = await prisma.user.create({
        data: { name: 'Hidden Doctor', email: `hidden-${Date.now()}@test.com` },
      });
      await prisma.doctor.create({
        data: {
          userId: hiddenDoctorUser.id,
          clinicId: pendingClinic.id,
          specialty: 'HiddenSpecialtyAbc',
          consultationFee: 50,
          approvalStatus: 'APPROVED',
        },
      });

      const response = await request(app).get(
        '/api/doctors?search=HiddenSpecialtyAbc',
      );
      expect(response.body.data).toHaveLength(0);
    });

    it('returns 404 for a doctor that does not exist', async () => {
      const response = await request(app).get(
        '/api/doctors/cnonexistentdoctoridxxxxxxxxx',
      );
      expect(response.status).toBe(404);
    });
  });

  describe('availability management', () => {
    it('rejects a rule where endTime is before startTime', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });

      const response = await request(app)
        .post('/api/doctors/me/availability')
        .send({
          weekday: 2,
          startTime: '14:00',
          endTime: '10:00',
          slotDurationMin: 30,
          bufferMin: 0,
        });

      expect(response.status).toBe(400);
    });

    it('rejects an overlapping rule on the same weekday', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });

      await request(app)
        .post('/api/doctors/me/availability')
        .send({
          weekday: 2,
          startTime: '09:00',
          endTime: '12:00',
          slotDurationMin: 30,
          bufferMin: 0,
        })
        .expect(201);

      const overlapping = await request(app)
        .post('/api/doctors/me/availability')
        .send({
          weekday: 2,
          startTime: '11:00',
          endTime: '13:00',
          slotDurationMin: 30,
          bufferMin: 0,
        });

      expect(overlapping.status).toBe(409);
    });

    it('blocks an unapproved doctor from managing availability', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'PENDING',
      });

      const response = await request(app)
        .post('/api/doctors/me/availability')
        .send({
          weekday: 2,
          startTime: '09:00',
          endTime: '12:00',
          slotDurationMin: 30,
          bufferMin: 0,
        });

      expect(response.status).toBe(403);
    });

    it("deletes only the requesting doctor's own availability rule", async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });
      const created = await request(app)
        .post('/api/doctors/me/availability')
        .send({
          weekday: 4,
          startTime: '09:00',
          endTime: '12:00',
          slotDurationMin: 30,
          bufferMin: 0,
        });

      const otherDoctorUser = await prisma.user.create({
        data: {
          name: 'Other Doctor',
          email: `other-doc-${Date.now()}@test.com`,
        },
      });
      await prisma.doctor.create({
        data: {
          userId: otherDoctorUser.id,
          clinicId,
          specialty: 'Other',
          consultationFee: 60,
          approvalStatus: 'APPROVED',
        },
      });

      setTestUser({
        id: otherDoctorUser.id,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });
      const wrongDelete = await request(app).delete(
        `/api/doctors/me/availability/${created.body.id}`,
      );
      expect(wrongDelete.status).toBe(404);

      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });
      const rightDelete = await request(app).delete(
        `/api/doctors/me/availability/${created.body.id}`,
      );
      expect(rightDelete.status).toBe(204);
    });
  });

  describe('leave days (exceptions)', () => {
    it('blocks a leave day that already has an active booking', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });

      const patient = await prisma.user.create({
        data: {
          name: 'Exception Patient',
          email: `exc-patient-${Date.now()}@test.com`,
        },
      });
      const dateKey = futureDateKey(10);

      await prisma.appointment.create({
        data: {
          doctorId,
          patientId: patient.id,
          slotStart: new Date(`${dateKey}T10:00:00.000Z`),
          slotEnd: new Date(`${dateKey}T10:30:00.000Z`),
          status: 'BOOKED',
        },
      });

      const response = await request(app)
        .post('/api/doctors/me/exceptions')
        .send({ date: dateKey });
      expect(response.status).toBe(409);
    });

    it('creates and then deletes a leave day with no bookings', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });
      const dateKey = futureDateKey(20);

      const created = await request(app)
        .post('/api/doctors/me/exceptions')
        .send({ date: dateKey });
      expect(created.status).toBe(201);

      const duplicate = await request(app)
        .post('/api/doctors/me/exceptions')
        .send({ date: dateKey });
      expect(duplicate.status).toBe(409);

      const deleted = await request(app).delete(
        `/api/doctors/me/exceptions/${created.body.id}`,
      );
      expect(deleted.status).toBe(204);
    });
  });

  describe('appointment status updates', () => {
    it('blocks marking a future appointment complete', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });

      const patient = await prisma.user.create({
        data: {
          name: 'Status Patient',
          email: `status-patient-${Date.now()}@test.com`,
        },
      });
      const appointment = await prisma.appointment.create({
        data: {
          doctorId,
          patientId: patient.id,
          slotStart: new Date(Date.now() + 2 * 60 * 60 * 1000),
          slotEnd: new Date(Date.now() + 2.5 * 60 * 60 * 1000),
          status: 'BOOKED',
        },
      });

      const response = await request(app)
        .patch(`/api/doctors/me/appointments/${appointment.id}/status`)
        .send({ status: 'COMPLETED' });

      expect(response.status).toBe(400);
    });

    it('marks a past appointment complete', async () => {
      setTestUser({
        id: doctorUserId,
        role: 'DOCTOR',
        doctorApprovalStatus: 'APPROVED',
      });

      const patient = await prisma.user.create({
        data: {
          name: 'Past Patient',
          email: `past-patient-${Date.now()}@test.com`,
        },
      });
      const appointment = await prisma.appointment.create({
        data: {
          doctorId,
          patientId: patient.id,
          slotStart: new Date(Date.now() - 2 * 60 * 60 * 1000),
          slotEnd: new Date(Date.now() - 1.5 * 60 * 60 * 1000),
          status: 'BOOKED',
        },
      });

      const response = await request(app)
        .patch(`/api/doctors/me/appointments/${appointment.id}/status`)
        .send({ status: 'COMPLETED' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('COMPLETED');
    });
  });
});
