import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

type Approval = 'PENDING' | 'APPROVED' | 'REJECTED';

describe('admin review', () => {
  let suffix = '';
  let counter = 0;

  beforeEach(() => {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  async function createClinic(approvalStatus: Approval) {
    counter += 1;
    const admin = await prisma.user.create({
      data: {
        name: `Review Admin ${counter}`,
        email: `review-admin-${suffix}-${counter}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: `Review Clinic ${counter}`,
        address: '1 Review Road',
        adminUserId: admin.id,
        approvalStatus,
      },
    });

    return { admin, clinic };
  }

  async function createDoctor(clinicId: string, approvalStatus: Approval) {
    counter += 1;
    const user = await prisma.user.create({
      data: {
        name: `Review Doctor ${counter}`,
        email: `review-doctor-${suffix}-${counter}@test.com`,
        role: 'DOCTOR',
      },
    });

    return prisma.doctor.create({
      data: {
        userId: user.id,
        clinicId,
        specialty: 'Review',
        consultationFee: 40,
        approvalStatus,
      },
    });
  }

  async function bookAppointment(doctorId: string) {
    counter += 1;
    const patient = await prisma.user.create({
      data: {
        name: 'Review Patient',
        email: `review-patient-${suffix}-${counter}@test.com`,
      },
    });
    const slotStart = new Date(
      Date.now() + 24 * 60 * 60 * 1000 + counter * 60_000,
    );

    return prisma.appointment.create({
      data: {
        doctorId,
        patientId: patient.id,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'BOOKED',
      },
    });
  }

  function asSuperAdmin() {
    setTestUser({ id: 'review-super-admin', role: 'SUPER_ADMIN' });
  }

  function asClinicAdmin(id: string) {
    setTestUser({ id, role: 'CLINIC_ADMIN' });
  }

  function idsOf(body: { data: { id: string }[] }): string[] {
    return body.data.map(item => item.id);
  }

  it('lists clinics by status for a super admin', async () => {
    const pending = await createClinic('PENDING');
    const approved = await createClinic('APPROVED');
    asSuperAdmin();

    const response = await request(app).get(
      '/api/admin/clinics?status=PENDING&pageSize=50',
    );

    expect(response.status).toBe(200);
    expect(idsOf(response.body)).toContain(pending.clinic.id);
    expect(idsOf(response.body)).not.toContain(approved.clinic.id);
  });

  it('includes the applicant and the approved doctor count', async () => {
    const { admin, clinic } = await createClinic('APPROVED');
    await createDoctor(clinic.id, 'APPROVED');
    await createDoctor(clinic.id, 'PENDING');
    asSuperAdmin();

    const response = await request(app).get(
      '/api/admin/clinics?status=APPROVED&pageSize=50',
    );
    const row = response.body.data.find(
      (item: { id: string }) => item.id === clinic.id,
    );

    expect(row.doctorCount).toBe(1);
    expect(row.adminUser.email).toBe(admin.email);
  });

  it("limits a clinic admin to their own clinic's doctors", async () => {
    const own = await createClinic('APPROVED');
    const other = await createClinic('APPROVED');
    const ownDoctor = await createDoctor(own.clinic.id, 'PENDING');
    const otherDoctor = await createDoctor(other.clinic.id, 'PENDING');
    asClinicAdmin(own.admin.id);

    const response = await request(app).get('/api/admin/doctors?pageSize=50');

    expect(response.status).toBe(200);
    expect(idsOf(response.body)).toContain(ownDoctor.id);
    expect(idsOf(response.body)).not.toContain(otherDoctor.id);
    expect(
      response.body.data.every(
        (doctor: { clinic: { id: string } }) =>
          doctor.clinic.id === own.clinic.id,
      ),
    ).toBe(true);
  });

  it('keeps clinic admins out of the clinic list and rejects a bad status', async () => {
    const own = await createClinic('APPROVED');
    asClinicAdmin(own.admin.id);

    const forbidden = await request(app).get('/api/admin/clinics');
    expect(forbidden.status).toBe(403);

    asSuperAdmin();
    const invalid = await request(app).get('/api/admin/clinics?status=NOPE');
    expect(invalid.status).toBe(400);
  });

  it('reports pending counts in the platform metrics', async () => {
    const { clinic } = await createClinic('PENDING');
    await createDoctor(clinic.id, 'PENDING');
    asSuperAdmin();

    const response = await request(app).get('/api/admin/metrics');

    expect(response.body.pendingClinics).toBeGreaterThanOrEqual(1);
    expect(response.body.pendingDoctors).toBeGreaterThanOrEqual(1);
  });

  it('approves a pending clinic and refuses to repeat the decision', async () => {
    const { clinic } = await createClinic('PENDING');
    asSuperAdmin();

    const first = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'APPROVED' });
    const second = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'APPROVED' });

    expect(first.status).toBe(200);
    expect(first.body.approvalStatus).toBe('APPROVED');
    expect(second.status).toBe(409);
  });

  it('lets a rejected clinic be approved later', async () => {
    const { clinic } = await createClinic('REJECTED');
    asSuperAdmin();

    const response = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('APPROVED');
  });

  it('returns 404 for an unknown clinic and 400 for a decision that is not approve or reject', async () => {
    const { clinic } = await createClinic('PENDING');
    asSuperAdmin();

    const missing = await request(app)
      .patch('/api/admin/clinics/cnonexistentclinicidxxxxxxxx/approval')
      .send({ status: 'APPROVED' });
    const invalid = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'PENDING' });

    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
  });

  it('blocks revoking a clinic whose doctors still have booked appointments', async () => {
    const { clinic } = await createClinic('APPROVED');
    const doctor = await createDoctor(clinic.id, 'APPROVED');
    await bookAppointment(doctor.id);
    asSuperAdmin();

    const response = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'REJECTED' });

    expect(response.status).toBe(409);
    const current = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinic.id },
    });
    expect(current.approvalStatus).toBe('APPROVED');
  });

  it('revokes a clinic that has no booked appointments', async () => {
    const { clinic } = await createClinic('APPROVED');
    await createDoctor(clinic.id, 'APPROVED');
    asSuperAdmin();

    const response = await request(app)
      .patch(`/api/admin/clinics/${clinic.id}/approval`)
      .send({ status: 'REJECTED' });

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('REJECTED');
  });

  it('lets the owning clinic admin approve, revoke and reconsider a doctor', async () => {
    const { admin, clinic } = await createClinic('APPROVED');
    const doctor = await createDoctor(clinic.id, 'PENDING');
    asClinicAdmin(admin.id);

    const approve = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'APPROVED' });
    const revoke = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'REJECTED' });
    const reconsider = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'APPROVED' });

    expect(approve.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(revoke.body.approvalStatus).toBe('REJECTED');
    expect(reconsider.status).toBe(200);
    expect(reconsider.body.approvalStatus).toBe('APPROVED');
  });

  it('blocks revoking a doctor who still has booked appointments', async () => {
    const { admin, clinic } = await createClinic('APPROVED');
    const doctor = await createDoctor(clinic.id, 'APPROVED');
    await bookAppointment(doctor.id);
    asClinicAdmin(admin.id);

    const response = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'REJECTED' });

    expect(response.status).toBe(409);
    const current = await prisma.doctor.findUniqueOrThrow({
      where: { id: doctor.id },
    });
    expect(current.approvalStatus).toBe('APPROVED');
  });

  it("does not let another clinic's admin decide on a doctor", async () => {
    const own = await createClinic('APPROVED');
    const other = await createClinic('APPROVED');
    const doctor = await createDoctor(own.clinic.id, 'PENDING');
    asClinicAdmin(other.admin.id);

    const response = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'APPROVED' });

    expect(response.status).toBe(403);
  });

  it('lets a super admin decide on any doctor', async () => {
    const { clinic } = await createClinic('APPROVED');
    const doctor = await createDoctor(clinic.id, 'PENDING');
    asSuperAdmin();

    const response = await request(app)
      .patch(`/api/admin/doctors/${doctor.id}/approval`)
      .send({ status: 'REJECTED' });

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('REJECTED');
  });
});
