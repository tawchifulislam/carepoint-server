import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

const HOUR = 60 * 60 * 1000;
const LIST = '/api/doctors/me/appointments';

describe('doctor appointment lists', () => {
  const ids: Record<string, string> = {};
  let doctorUserId = '';

  function idFor(label: string): string {
    return ids[label] ?? '';
  }

  function idsOf(body: { data: { id: string }[] }): string[] {
    return body.data.map(item => item.id);
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: { name: 'List Admin', email: `list-admin-${suffix}@test.com` },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'List Clinic',
        address: 'Somewhere',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });

    const doctorUser = await prisma.user.create({
      data: {
        name: 'List Doctor',
        email: `list-doctor-${suffix}@test.com`,
        role: 'DOCTOR',
      },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: clinic.id,
        specialty: 'List',
        consultationFee: 30,
        approvalStatus: 'APPROVED',
      },
    });

    const otherUser = await prisma.user.create({
      data: {
        name: 'Other List Doctor',
        email: `list-other-${suffix}@test.com`,
        role: 'DOCTOR',
      },
    });
    const otherDoctor = await prisma.doctor.create({
      data: {
        userId: otherUser.id,
        clinicId: clinic.id,
        specialty: 'Other',
        consultationFee: 30,
        approvalStatus: 'APPROVED',
      },
    });

    const patient = await prisma.user.create({
      data: { name: 'List Patient', email: `list-patient-${suffix}@test.com` },
    });

    async function add(
      label: string,
      doctorId: string,
      hoursFromNow: number,
      status: 'BOOKED' | 'COMPLETED' | 'CANCELLED' | 'PENDING_PAYMENT',
    ) {
      const slotStart = new Date(Date.now() + hoursFromNow * HOUR);
      const appointment = await prisma.appointment.create({
        data: {
          doctorId,
          patientId: patient.id,
          slotStart,
          slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
          status,
        },
      });
      ids[label] = appointment.id;
    }

    await add('bookedLater', doctor.id, 48, 'BOOKED');
    await add('bookedSoon', doctor.id, 24, 'BOOKED');
    await add('bookedOverdue', doctor.id, -5, 'BOOKED');
    await add('completed', doctor.id, -3, 'COMPLETED');
    await add('cancelled', doctor.id, -48, 'CANCELLED');
    await add('pending', doctor.id, 10, 'PENDING_PAYMENT');
    await add('otherDoctor', otherDoctor.id, 20, 'BOOKED');

    doctorUserId = doctorUser.id;
  }, 120_000);

  beforeEach(() => {
    setTestUser({
      id: doctorUserId,
      role: 'DOCTOR',
      doctorApprovalStatus: 'APPROVED',
    });
  });

  it('lists only booked appointments, soonest first', async () => {
    const response = await request(app).get(`${LIST}?scope=schedule`);

    expect(response.status).toBe(200);
    expect(idsOf(response.body)).toEqual([
      idFor('bookedOverdue'),
      idFor('bookedSoon'),
      idFor('bookedLater'),
    ]);
    expect(response.body.total).toBe(3);
  });

  it('defaults to the schedule scope', async () => {
    const response = await request(app).get(LIST);

    expect(idsOf(response.body)).toEqual([
      idFor('bookedOverdue'),
      idFor('bookedSoon'),
      idFor('bookedLater'),
    ]);
  });

  it("never exposes unpaid holds or another doctor's appointments", async () => {
    const schedule = await request(app).get(`${LIST}?scope=schedule`);
    const history = await request(app).get(`${LIST}?scope=history`);
    const combined = JSON.stringify([schedule.body, history.body]);

    expect(combined).not.toContain(idFor('pending'));
    expect(combined).not.toContain(idFor('otherDoctor'));
  });

  it('lists history with the most recent first', async () => {
    const response = await request(app).get(`${LIST}?scope=history`);

    expect(response.status).toBe(200);
    expect(idsOf(response.body)).toEqual([
      idFor('completed'),
      idFor('cancelled'),
    ]);
  });

  it('narrows history by status', async () => {
    const response = await request(app).get(
      `${LIST}?scope=history&status=CANCELLED`,
    );

    expect(idsOf(response.body)).toEqual([idFor('cancelled')]);
  });

  it('rejects a status that does not belong to history and an unknown scope', async () => {
    const wrongStatus = await request(app).get(
      `${LIST}?scope=history&status=BOOKED`,
    );
    const wrongScope = await request(app).get(`${LIST}?scope=everything`);

    expect(wrongStatus.status).toBe(400);
    expect(wrongScope.status).toBe(400);
  });

  it('paginates the schedule', async () => {
    const response = await request(app).get(
      `${LIST}?scope=schedule&pageSize=1&page=2`,
    );

    expect(idsOf(response.body)).toEqual([idFor('bookedSoon')]);
    expect(response.body.totalPages).toBe(3);
  });
});
