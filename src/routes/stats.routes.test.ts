import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';

async function createDoctor(
  specialty: string,
  doctorStatus: 'APPROVED' | 'PENDING',
) {
  const admin = await prisma.user.create({
    data: {
      name: 'Stats Admin',
      email: `stats-admin-${Date.now()}-${specialty}@test.com`,
    },
  });
  const clinic = await prisma.clinic.create({
    data: {
      name: 'Stats Clinic',
      address: 'Somewhere',
      adminUserId: admin.id,
      approvalStatus: 'APPROVED',
    },
  });
  const doctorUser = await prisma.user.create({
    data: {
      name: 'Stats Doctor',
      email: `stats-doctor-${Date.now()}-${specialty}@test.com`,
    },
  });

  await prisma.doctor.create({
    data: {
      userId: doctorUser.id,
      clinicId: clinic.id,
      specialty,
      consultationFee: 50,
      approvalStatus: doctorStatus,
    },
  });
}

describe('GET /api/stats', () => {
  it('counts approved doctors per specialty and returns the booked total', async () => {
    await createDoctor('StatsSpecialtyQrs', 'APPROVED');

    const response = await request(app).get('/api/stats');

    expect(response.status).toBe(200);
    expect(typeof response.body.appointmentsBooked).toBe('number');
    expect(response.body.specialties).toContainEqual({
      name: 'StatsSpecialtyQrs',
      doctorCount: 1,
    });
  });

  it('excludes doctors that are not approved', async () => {
    await createDoctor('HiddenStatsXyz', 'PENDING');

    const response = await request(app).get('/api/stats');

    const names = response.body.specialties.map(
      (s: { name: string }) => s.name,
    );
    expect(names).not.toContain('HiddenStatsXyz');
  });
});
