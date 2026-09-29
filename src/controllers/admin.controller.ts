import type { Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { approvalDecisionSchema } from '../lib/validators/approval.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

export async function decideClinicApproval(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid clinic id' });
    return;
  }

  const parsed = approvalDecisionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const clinic = await prisma.clinic.update({
    where: { id: params.data.id },
    data: { approvalStatus: parsed.data.status },
  });

  res.json(clinic);
}

export async function decideDoctorApproval(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid doctor id' });
    return;
  }

  const parsed = approvalDecisionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: params.data.id },
    include: { clinic: true },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  const isOwningClinicAdmin =
    req.user!.role === 'CLINIC_ADMIN' &&
    doctor.clinic.adminUserId === req.user!.id;

  if (!isOwningClinicAdmin && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Not authorized to approve this doctor' });
    return;
  }

  const updated = await prisma.doctor.update({
    where: { id: params.data.id },
    data: { approvalStatus: parsed.data.status },
  });

  res.json(updated);
}

export async function listPendingClinics(
  _req: AuthenticatedRequest,
  res: Response,
) {
  const clinics = await prisma.clinic.findMany({
    where: { approvalStatus: 'PENDING' },
    select: {
      id: true,
      name: true,
      address: true,
      createdAt: true,
      adminUser: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json(clinics);
}

export async function listPendingDoctors(
  req: AuthenticatedRequest,
  res: Response,
) {
  const where: Prisma.DoctorWhereInput = { approvalStatus: 'PENDING' };

  if (req.user!.role === 'CLINIC_ADMIN') {
    const clinic = await prisma.clinic.findUnique({
      where: { adminUserId: req.user!.id },
    });

    if (!clinic) {
      res.status(404).json({ error: 'Clinic profile not found' });
      return;
    }

    where.clinicId = clinic.id;
  }

  const doctors = await prisma.doctor.findMany({
    where,
    select: {
      id: true,
      specialty: true,
      consultationFee: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      clinic: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json(doctors);
}

export async function getPlatformMetrics(
  _req: AuthenticatedRequest,
  res: Response,
) {
  const [approvedClinics, approvedDoctors, patients, totalBookings, revenue] =
    await Promise.all([
      prisma.clinic.count({ where: { approvalStatus: 'APPROVED' } }),
      prisma.doctor.count({ where: { approvalStatus: 'APPROVED' } }),
      prisma.user.count({ where: { role: 'PATIENT' } }),
      prisma.appointment.count({
        where: { status: { in: ['BOOKED', 'COMPLETED'] } },
      }),
      prisma.payment.aggregate({
        where: { status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
    ]);

  res.json({
    approvedClinics,
    approvedDoctors,
    patients,
    totalBookings,
    totalRevenue: Number(revenue._sum.amount ?? 0),
  });
}
