import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

describe('admin routes', () => {
  let pendingClinicId: string;
  let approvedClinicAdminId: string;
  let approvedClinicId: string;
  let pendingDoctorId: string;
  let pendingClinicAdminId: string;

  beforeEach(async () => {
    const pendingAdmin = await prisma.user.create({
      data: {
        name: 'Pending Clinic Admin',
        email: `pca-${Date.now()}@test.com`,
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

    const approvedAdmin = await prisma.user.create({
      data: {
        name: 'Approved Clinic Admin',
        email: `aca-${Date.now()}@test.com`,
      },
    });
    const approvedClinic = await prisma.clinic.create({
      data: {
        name: 'Approved Clinic',
        address: 'Somewhere',
        adminUserId: approvedAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });

    const doctorUser = await prisma.user.create({
      data: { name: 'Pending Doctor', email: `pd-${Date.now()}@test.com` },
    });
    const doctor = await prisma.doctor.create({
      data: {
        userId: doctorUser.id,
        clinicId: approvedClinic.id,
        specialty: 'Testing',
        consultationFee: 80,
        approvalStatus: 'PENDING',
      },
    });

    pendingClinicId = pendingClinic.id;
    approvedClinicAdminId = approvedAdmin.id;
    approvedClinicId = approvedClinic.id;
    pendingDoctorId = doctor.id;
    pendingClinicAdminId = pendingAdmin.id;
  });

  it('lets a super admin approve a pending clinic', async () => {
    setTestUser({ id: 'any-super-admin', role: 'SUPER_ADMIN' });

    const response = await request(app)
      .patch(`/api/admin/clinics/${pendingClinicId}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('APPROVED');
  });

  it('blocks a clinic admin from approving clinics', async () => {
    setTestUser({ id: approvedClinicAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app)
      .patch(`/api/admin/clinics/${pendingClinicId}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(403);
  });

  it('lets the owning, approved clinic admin approve their own doctor', async () => {
    setTestUser({ id: approvedClinicAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app)
      .patch(`/api/admin/doctors/${pendingDoctorId}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(200);
  });

  it('blocks a clinic admin whose own clinic is still pending from approving a doctor', async () => {
    const otherDoctorUser = await prisma.user.create({
      data: {
        name: 'Other Pending Doctor',
        email: `opd-${Date.now()}@test.com`,
      },
    });
    const otherDoctor = await prisma.doctor.create({
      data: {
        userId: otherDoctorUser.id,
        clinicId: pendingClinicId,
        specialty: 'Testing',
        consultationFee: 80,
        approvalStatus: 'PENDING',
      },
    });

    setTestUser({ id: pendingClinicAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app)
      .patch(`/api/admin/doctors/${otherDoctor.id}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(403);
  });

  it('blocks a different clinic admin from approving a doctor outside their clinic', async () => {
    const strangerAdmin = await prisma.user.create({
      data: {
        name: 'Stranger Admin',
        email: `stranger-${Date.now()}@test.com`,
      },
    });

    setTestUser({ id: strangerAdmin.id, role: 'CLINIC_ADMIN' });

    const response = await request(app)
      .patch(`/api/admin/doctors/${pendingDoctorId}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(403);
  });

  it("scopes the pending-doctors list to the clinic admin's own clinic", async () => {
    setTestUser({ id: approvedClinicAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app).get('/api/admin/doctors/pending');

    expect(response.status).toBe(200);
    expect(
      response.body.every(
        (d: { clinic: { id: string } }) => d.clinic.id === approvedClinicId,
      ),
    ).toBe(true);
  });

  it('returns platform metrics for a super admin', async () => {
    setTestUser({ id: 'any-super-admin', role: 'SUPER_ADMIN' });

    const response = await request(app).get('/api/admin/metrics');

    expect(response.status).toBe(200);
    expect(typeof response.body.approvedClinics).toBe('number');
  });

  it('blocks a doctor from viewing platform metrics', async () => {
    setTestUser({ id: 'some-doctor', role: 'DOCTOR' });

    const response = await request(app).get('/api/admin/metrics');

    expect(response.status).toBe(403);
  });
});
