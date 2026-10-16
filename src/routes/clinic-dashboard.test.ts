import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

const DAY = 24 * 60 * 60 * 1000;

function dhakaKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function daysAgoKey(days: number): string {
  return dhakaKey(new Date(Date.now() - days * DAY));
}

describe('clinic dashboard ranges', () => {
  let adminId = '';
  let otherAdminId = '';
  let clinicId = '';

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const admin = await prisma.user.create({
      data: {
        name: 'Dash Admin',
        email: `dash-admin-${suffix}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    const clinic = await prisma.clinic.create({
      data: {
        name: 'Dash Clinic',
        address: '1 Dash Road',
        adminUserId: admin.id,
        approvalStatus: 'APPROVED',
      },
    });

    const otherAdmin = await prisma.user.create({
      data: {
        name: 'Other Dash Admin',
        email: `dash-other-${suffix}@test.com`,
        role: 'CLINIC_ADMIN',
      },
    });
    await prisma.clinic.create({
      data: {
        name: 'Other Dash Clinic',
        address: '2 Dash Road',
        adminUserId: otherAdmin.id,
        approvalStatus: 'APPROVED',
      },
    });

    async function createDoctor(
      name: string,
      approvalStatus: 'APPROVED' | 'PENDING',
    ) {
      const user = await prisma.user.create({
        data: {
          name,
          email: `${name.replace(' ', '-').toLowerCase()}-${suffix}@test.com`,
          role: 'DOCTOR',
        },
      });

      return prisma.doctor.create({
        data: {
          userId: user.id,
          clinicId: clinic.id,
          specialty: 'Dash',
          consultationFee: 10,
          approvalStatus,
        },
      });
    }

    const alpha = await createDoctor('Dash Alpha', 'APPROVED');
    const beta = await createDoctor('Dash Beta', 'APPROVED');
    await createDoctor('Dash Gamma', 'PENDING');

    const patient = await prisma.user.create({
      data: { name: 'Dash Patient', email: `dash-patient-${suffix}@test.com` },
    });

    let counter = 0;

    async function pay(
      doctorId: string,
      status: 'BOOKED' | 'COMPLETED' | 'CANCELLED',
      amount: number,
      daysAgo: number,
      paymentStatus: 'SUCCEEDED' | 'REFUNDED' = 'SUCCEEDED',
    ) {
      counter += 1;
      const slotStart = new Date(Date.now() + counter * 60 * 60 * 1000);
      const appointment = await prisma.appointment.create({
        data: {
          doctorId,
          patientId: patient.id,
          slotStart,
          slotEnd: new Date(slotStart.getTime() + 30 * 60 * 1000),
          status,
        },
      });

      await prisma.payment.create({
        data: {
          appointment: { connect: { id: appointment.id } },
          stripePaymentIntentId: `pi_dash_${suffix}_${counter}`,
          amount,
          status: paymentStatus,
          createdAt: new Date(Date.now() - daysAgo * DAY),
        },
      });
    }

    await pay(alpha.id, 'COMPLETED', 9, 2);
    await pay(beta.id, 'BOOKED', 10, 5);
    await pay(beta.id, 'BOOKED', 5, 10);
    await pay(beta.id, 'BOOKED', 20, 45);
    await pay(alpha.id, 'CANCELLED', 50, 3, 'REFUNDED');

    adminId = admin.id;
    otherAdminId = otherAdmin.id;
    clinicId = clinic.id;
  }, 120_000);

  function asOwner() {
    setTestUser({ id: adminId, role: 'CLINIC_ADMIN' });
  }

  it('limits totals to the selected range', async () => {
    asOwner();

    const week = await request(app).get('/api/clinics/me/dashboard?range=7d');
    const month = await request(app).get('/api/clinics/me/dashboard?range=30d');
    const all = await request(app).get('/api/clinics/me/dashboard?range=all');

    expect(week.body.totals).toMatchObject({ revenue: 19, bookings: 2 });
    expect(month.body.totals).toMatchObject({ revenue: 24, bookings: 3 });
    expect(all.body.totals).toMatchObject({ revenue: 44, bookings: 4 });
  });

  it('sorts doctors by revenue as a number, not as text', async () => {
    asOwner();

    const week = await request(app).get('/api/clinics/me/dashboard?range=7d');
    const month = await request(app).get('/api/clinics/me/dashboard?range=30d');

    expect(
      week.body.doctors
        .map((doctor: { doctorName: string }) => doctor.doctorName)
        .slice(0, 2),
    ).toEqual(['Dash Beta', 'Dash Alpha']);
    expect(month.body.doctors[0]).toMatchObject({
      doctorName: 'Dash Beta',
      revenue: 15,
      bookingCount: 2,
    });
    expect(month.body.doctors[1]).toMatchObject({
      doctorName: 'Dash Alpha',
      revenue: 9,
      bookingCount: 1,
    });
  });

  it('reports daily revenue by Bangladesh date and leaves out refunded payments', async () => {
    asOwner();

    const response = await request(app).get(
      '/api/clinics/me/dashboard?range=30d',
    );
    const byDate = Object.fromEntries(
      response.body.series.map((point: { date: string; revenue: number }) => [
        point.date,
        point.revenue,
      ]),
    );

    expect(byDate[daysAgoKey(2)]).toBe(9);
    expect(byDate[daysAgoKey(5)]).toBe(10);
    expect(byDate[daysAgoKey(10)]).toBe(5);
    expect(byDate[daysAgoKey(3)]).toBeUndefined();
    expect(byDate[daysAgoKey(45)]).toBeUndefined();
  });

  it('counts approved and pending doctors', async () => {
    asOwner();

    const response = await request(app).get('/api/clinics/me/dashboard');

    expect(response.body.totals).toMatchObject({
      activeDoctors: 2,
      pendingDoctors: 1,
    });
  });

  it('defaults to thirty days and rejects an unknown range', async () => {
    asOwner();

    const defaulted = await request(app).get('/api/clinics/me/dashboard');
    const invalid = await request(app).get(
      '/api/clinics/me/dashboard?range=1y',
    );

    expect(defaulted.body.range).toBe('30d');
    expect(invalid.status).toBe(400);
  });

  it("keeps another clinic's admin out", async () => {
    setTestUser({ id: otherAdminId, role: 'CLINIC_ADMIN' });

    const response = await request(app).get(
      `/api/clinics/${clinicId}/dashboard`,
    );

    expect(response.status).toBe(403);
  });
});
