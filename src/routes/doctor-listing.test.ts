import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';

async function createApprovedDoctor(specialty: string) {
  const admin = await prisma.user.create({
    data: {
      name: 'Next Slot Admin',
      email: `ns-admin-${Date.now()}-${specialty}@test.com`,
    },
  });
  const clinic = await prisma.clinic.create({
    data: {
      name: 'Next Slot Clinic',
      address: 'Somewhere',
      adminUserId: admin.id,
      approvalStatus: 'APPROVED',
    },
  });
  const doctorUser = await prisma.user.create({
    data: {
      name: 'Next Slot Doctor',
      email: `ns-doctor-${Date.now()}-${specialty}@test.com`,
    },
  });

  return prisma.doctor.create({
    data: {
      userId: doctorUser.id,
      clinicId: clinic.id,
      specialty,
      consultationFee: 40,
      approvalStatus: 'APPROVED',
    },
  });
}

async function addAllDayAvailability(doctorId: string) {
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availability.create({
      data: {
        doctorId,
        weekday,
        startTime: '00:00',
        endTime: '23:30',
        slotDurationMin: 30,
        bufferMin: 0,
      },
    });
  }
}

describe('doctor listing next available slot', () => {
  it('returns the earliest upcoming slot for a doctor with availability', async () => {
    const doctor = await createApprovedDoctor('NextSlotSpecialtyAaa');
    await addAllDayAvailability(doctor.id);

    const response = await request(app).get(
      '/api/doctors?search=NextSlotSpecialtyAaa',
    );

    expect(response.status).toBe(200);
    const slot: string = response.body.data[0].nextAvailableSlot;
    expect(typeof slot).toBe('string');
    expect(new Date(slot).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a doctor with no availability rules', async () => {
    await createApprovedDoctor('NextSlotSpecialtyBbb');

    const response = await request(app).get(
      '/api/doctors?search=NextSlotSpecialtyBbb',
    );

    expect(response.body.data[0].nextAvailableSlot).toBeNull();
  });

  it('skips a slot that is already booked', async () => {
    const doctor = await createApprovedDoctor('NextSlotSpecialtyCcc');
    await addAllDayAvailability(doctor.id);
    const patient = await prisma.user.create({
      data: {
        name: 'Next Slot Patient',
        email: `ns-patient-${Date.now()}@test.com`,
      },
    });

    const first = await request(app).get(
      '/api/doctors?search=NextSlotSpecialtyCcc',
    );
    const firstSlot: string = first.body.data[0].nextAvailableSlot;

    await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        slotStart: new Date(firstSlot),
        slotEnd: new Date(new Date(firstSlot).getTime() + 30 * 60 * 1000),
        status: 'BOOKED',
      },
    });

    const second = await request(app).get(
      '/api/doctors?search=NextSlotSpecialtyCcc',
    );
    const secondSlot: string = second.body.data[0].nextAvailableSlot;

    expect(new Date(secondSlot).getTime()).toBeGreaterThan(
      new Date(firstSlot).getTime(),
    );
  });
});
