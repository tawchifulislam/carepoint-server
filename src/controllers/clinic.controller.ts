import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createClinicSchema } from '../lib/validators/clinic.schema.js';
import {
  dashboardQuerySchema,
  RANGE_DAYS,
  type DashboardRange,
} from '../lib/validators/clinic-dashboard.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

interface DoctorRevenueRow {
  doctorId: string;
  doctorName: string;
  bookingCount: number;
  revenue: string;
}

interface SeriesRow {
  date: string;
  bookings: number;
  revenue: string;
}

interface DashboardClinic {
  id: string;
  name: string;
  address: string;
  approvalStatus: string;
}

export async function listApprovedClinics(_req: Request, res: Response) {
  const clinics = await prisma.clinic.findMany({
    where: { approvalStatus: 'APPROVED' },
    select: { id: true, name: true, address: true },
    orderBy: { name: 'asc' },
  });

  res.json(clinics);
}

export async function applyAsClinicAdmin(
  req: AuthenticatedRequest,
  res: Response,
) {
  const parsed = createClinicSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = await prisma.clinic.findUnique({
    where: { adminUserId: req.user!.id },
  });

  if (existing) {
    res.status(409).json({ error: 'You have already registered a clinic' });
    return;
  }

  const clinic = await prisma.clinic.create({
    data: { ...parsed.data, adminUserId: req.user!.id },
  });

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { role: 'CLINIC_ADMIN' },
  });

  res.status(201).json(clinic);
}

export async function getMyClinic(req: AuthenticatedRequest, res: Response) {
  const clinic = await prisma.clinic.findUnique({
    where: { adminUserId: req.user!.id },
  });

  if (!clinic) {
    res.status(404).json({ error: 'Clinic profile not found' });
    return;
  }

  res.json(clinic);
}

export async function listMyClinicDoctors(
  req: AuthenticatedRequest,
  res: Response,
) {
  const clinic = await prisma.clinic.findUnique({
    where: { adminUserId: req.user!.id },
  });

  if (!clinic) {
    res.status(404).json({ error: 'Clinic profile not found' });
    return;
  }

  const doctors = await prisma.doctor.findMany({
    where: { clinicId: clinic.id },
    select: {
      id: true,
      specialty: true,
      approvalStatus: true,
      consultationFee: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(doctors);
}

async function sendDashboard(
  res: Response,
  clinic: DashboardClinic,
  range: DashboardRange,
) {
  const days = RANGE_DAYS[range];

  const since = Prisma.sql`((date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') - make_interval(days => ${days}::int - 1)) AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'UTC'`;

  const [rows, series, activeDoctors, pendingDoctors] = await Promise.all([
    prisma.$queryRaw<DoctorRevenueRow[]>`
      SELECT d.id AS "doctorId", u.name AS "doctorName",
             COUNT(paid.appointment_id)::int AS "bookingCount",
             COALESCE(SUM(paid.amount), 0)::text AS "revenue"
      FROM doctors d
      JOIN users u ON u.id = d."userId"
      LEFT JOIN (
        SELECT a."doctorId" AS doctor_id, a.id AS appointment_id, p.amount AS amount
        FROM appointments a
        JOIN payments p ON p."appointmentId" = a.id
        WHERE a.status IN ('BOOKED', 'COMPLETED')
          AND p.status = 'SUCCEEDED'
          AND p."createdAt" >= ${since}
      ) paid ON paid.doctor_id = d.id
      WHERE d."clinicId" = ${clinic.id}
      GROUP BY d.id, u.name
      ORDER BY COALESCE(SUM(paid.amount), 0) DESC, u.name ASC
    `,
    prisma.$queryRaw<SeriesRow[]>`
      SELECT to_char(((p."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS "date",
             COUNT(*)::int AS "bookings",
             COALESCE(SUM(p.amount), 0)::text AS "revenue"
      FROM payments p
      JOIN appointments a ON a.id = p."appointmentId"
      JOIN doctors d ON d.id = a."doctorId"
      WHERE d."clinicId" = ${clinic.id}
        AND a.status IN ('BOOKED', 'COMPLETED')
        AND p.status = 'SUCCEEDED'
        AND p."createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.doctor.count({
      where: { clinicId: clinic.id, approvalStatus: 'APPROVED' },
    }),
    prisma.doctor.count({
      where: { clinicId: clinic.id, approvalStatus: 'PENDING' },
    }),
  ]);

  const doctors = rows.map(row => ({
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    bookingCount: row.bookingCount,
    revenue: Number(row.revenue),
  }));

  res.json({
    clinicId: clinic.id,
    clinicName: clinic.name,
    address: clinic.address,
    approvalStatus: clinic.approvalStatus,
    range,
    totals: {
      revenue: doctors.reduce((sum, doctor) => sum + doctor.revenue, 0),
      bookings: doctors.reduce((sum, doctor) => sum + doctor.bookingCount, 0),
      activeDoctors,
      pendingDoctors,
    },
    doctors,
    series: series.map(row => ({
      date: row.date,
      bookings: row.bookings,
      revenue: Number(row.revenue),
    })),
  });
}

export async function getClinicDashboard(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid clinic id' });
    return;
  }

  const query = dashboardQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: params.data.id },
  });

  if (!clinic) {
    res.status(404).json({ error: 'Clinic not found' });
    return;
  }

  const isOwner =
    req.user!.role === 'CLINIC_ADMIN' && clinic.adminUserId === req.user!.id;

  if (!isOwner && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Not authorized to view this dashboard' });
    return;
  }

  await sendDashboard(res, clinic, query.data.range);
}

export async function getMyClinicDashboard(
  req: AuthenticatedRequest,
  res: Response,
) {
  const query = dashboardQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const clinic = await prisma.clinic.findUnique({
    where: { adminUserId: req.user!.id },
  });

  if (!clinic) {
    res.status(404).json({ error: 'Clinic profile not found' });
    return;
  }

  await sendDashboard(res, clinic, query.data.range);
}
