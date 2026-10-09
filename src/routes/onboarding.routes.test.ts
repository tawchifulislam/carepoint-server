import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

type TestRole = 'PATIENT' | 'DOCTOR' | 'CLINIC_ADMIN' | 'SUPER_ADMIN';

describe('onboarding applications', () => {
  let suffix: string;
  let approvedClinicId: string;

  beforeEach(async () => {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: {
        name: 'Onboarding Admin',
        email: `onboarding-admin-${suffix}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Onboarding Clinic',
        address: '12 Test Road',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });

    approvedClinicId = clinic.id;
  });

  async function createUser(role: TestRole) {
    return prisma.user.create({
      data: {
        name: `Onboarding ${role}`,
        email: `onboarding-${role}-${suffix}@test.com`,
        role,
      },
    });
  }

  async function roleOf(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.role;
  }

  it('lets a patient register a clinic and makes them its admin', async () => {
    const user = await createUser('PATIENT');
    setTestUser({ id: user.id, role: 'PATIENT' });

    const response = await request(app)
      .post('/api/clinics')
      .send({ name: 'Fresh Clinic', address: '99 Fresh Street' });

    expect(response.status).toBe(201);
    expect(await roleOf(user.id)).toBe('CLINIC_ADMIN');
  });

  it('leaves a super admin untouched when they try to register a clinic', async () => {
    const user = await createUser('SUPER_ADMIN');
    setTestUser({ id: user.id, role: 'SUPER_ADMIN' });

    const response = await request(app)
      .post('/api/clinics')
      .send({ name: 'Admin Clinic', address: '1 Admin Street' });

    expect(response.status).toBe(403);
    expect(await roleOf(user.id)).toBe('SUPER_ADMIN');
    expect(await prisma.clinic.count({ where: { adminUserId: user.id } })).toBe(
      0,
    );
  });

  it('blocks a doctor from registering a clinic', async () => {
    const user = await createUser('DOCTOR');
    setTestUser({ id: user.id, role: 'DOCTOR' });

    const response = await request(app)
      .post('/api/clinics')
      .send({ name: 'Doctor Clinic', address: '2 Doctor Street' });

    expect(response.status).toBe(403);
    expect(await roleOf(user.id)).toBe('DOCTOR');
  });

  it('lets a patient apply as a doctor to an approved clinic', async () => {
    const user = await createUser('PATIENT');
    setTestUser({ id: user.id, role: 'PATIENT' });

    const response = await request(app).post('/api/doctors').send({
      clinicId: approvedClinicId,
      specialty: 'Cardiology',
      consultationFee: 40,
    });

    expect(response.status).toBe(201);
    expect(response.body.approvalStatus).toBe('PENDING');
    expect(await roleOf(user.id)).toBe('DOCTOR');
  });

  it('blocks a clinic admin from applying as a doctor', async () => {
    const user = await createUser('CLINIC_ADMIN');
    setTestUser({ id: user.id, role: 'CLINIC_ADMIN' });

    const response = await request(app).post('/api/doctors').send({
      clinicId: approvedClinicId,
      specialty: 'Cardiology',
      consultationFee: 40,
    });

    expect(response.status).toBe(403);
    expect(await roleOf(user.id)).toBe('CLINIC_ADMIN');
  });
});
