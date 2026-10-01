import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

describe('clinic dashboard authorization', () => {
  let ownAdminId: string;
  let otherAdminId: string;
  let clinicId: string;

  beforeEach(async () => {
    const ownAdmin = await prisma.user.create({
      data: {
        name: 'Own Admin',
        email: `own-${Date.now()}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        name: 'Other Admin',
        email: `other-${Date.now()}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Owned Clinic',
        address: 'Somewhere',
        adminUserId: ownAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });

    ownAdminId = ownAdmin.id;
    otherAdminId = otherAdmin.id;
    clinicId = clinic.id;
  });

  it('lets the owning clinic admin view their dashboard', async () => {
    setTestUser({ id: ownAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app).get(
      `/api/clinics/${clinicId}/dashboard`,
    );

    expect(response.status).toBe(200);
    expect(response.body.clinicId).toBe(clinicId);
  });

  it('blocks a different clinic admin from viewing this dashboard', async () => {
    setTestUser({ id: otherAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app).get(
      `/api/clinics/${clinicId}/dashboard`,
    );

    expect(response.status).toBe(403);
  });

  it('lets a super admin view any clinic dashboard', async () => {
    setTestUser({ id: 'any-super-admin', role: 'SUPER_ADMIN' });

    const response = await request(app).get(
      `/api/clinics/${clinicId}/dashboard`,
    );

    expect(response.status).toBe(200);
  });

  it('rejects requests with no authenticated user', async () => {
    setTestUser(null);

    const response = await request(app).get(
      `/api/clinics/${clinicId}/dashboard`,
    );

    expect(response.status).toBe(401);
  });
});
