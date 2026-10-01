import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';
import { prisma } from '../lib/prisma.js';
import { reserveAppointment } from './scheduling.service.js';

function nextWeekdayDateKey(targetWeekday: number): string {
  const now = new Date();
  const daysUntil = (targetWeekday - now.getUTCDay() + 7) % 7 || 7;
  const future = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntil,
    ),
  );
  return future.toISOString().slice(0, 10);
}

describe('concurrent booking', () => {
  let doctorId: string;
  let patientAId: string;
  let patientBId: string;
  let slotStart: string;

  beforeAll(async () => {
    const clinicAdmin = await prisma.user.create({
      data: {
        name: 'Test Clinic Admin',
        email: `clinic-admin-${Date.now()}@test.com`,
      },
    });

    const clinic = await prisma.clinic.create({
      data: {
        name: 'Test Clinic',
        address: 'Test Address',
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

    doctorId = doctor.id;

    const dateKey = nextWeekdayDateKey(0);

    await prisma.availability.create({
      data: {
        doctorId,
        weekday: 0,
        startTime: '10:00',
        endTime: '11:00',
        slotDurationMin: 30,
        bufferMin: 0,
      },
    });

    slotStart = fromZonedTime(
      `${dateKey}T10:00:00`,
      'Asia/Dhaka',
    ).toISOString();

    const patientA = await prisma.user.create({
      data: { name: 'Patient A', email: `patient-a-${Date.now()}@test.com` },
    });
    const patientB = await prisma.user.create({
      data: { name: 'Patient B', email: `patient-b-${Date.now()}@test.com` },
    });

    patientAId = patientA.id;
    patientBId = patientB.id;
  });

  afterAll(async () => {
    await prisma.appointment.deleteMany({ where: { doctorId } });
    await prisma.availability.deleteMany({ where: { doctorId } });
    await prisma.doctor.delete({ where: { id: doctorId } });
    await prisma.user.deleteMany({
      where: { id: { in: [patientAId, patientBId] } },
    });
  });

  it('only allows one of two simultaneous bookings for the same slot to succeed', async () => {
    const results = await Promise.allSettled([
      reserveAppointment(doctorId, patientAId, slotStart),
      reserveAppointment(doctorId, patientBId, slotStart),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});
