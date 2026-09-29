import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createClinicSchema } from '../lib/validators/clinic.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

interface DoctorRevenueRow {
  doctorId: string;
  doctorName: string;
  bookingCount: number;
  revenue: string;
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

export async function getClinicDashboard(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid clinic id' });
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

  const rows = await prisma.$queryRaw<DoctorRevenueRow[]>`
    SELECT d.id as "doctorId", u.name as "doctorName",
           COUNT(a.id)::int as "bookingCount",
           COALESCE(SUM(p.amount), 0)::text as "revenue"
    FROM doctors d
    JOIN users u ON u.id = d."userId"
    LEFT JOIN appointments a ON a."doctorId" = d.id AND a.status IN ('BOOKED', 'COMPLETED')
    LEFT JOIN payments p ON p."appointmentId" = a.id AND p.status = 'SUCCEEDED'
    WHERE d."clinicId" = ${params.data.id}
    GROUP BY d.id, u.name
    ORDER BY revenue DESC
  `;

  res.json({
    clinicId: clinic.id,
    clinicName: clinic.name,
    doctors: rows.map(row => ({
      doctorId: row.doctorId,
      doctorName: row.doctorName,
      bookingCount: row.bookingCount,
      revenue: Number(row.revenue),
    })),
  });
}
