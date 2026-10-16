import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { adminListQuerySchema } from '../lib/validators/admin-list.schema.js';
import { approvalDecisionSchema } from '../lib/validators/approval.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

type Decision = 'APPROVED' | 'REJECTED';
type ApprovalValue = 'PENDING' | 'APPROVED' | 'REJECTED';

const ALLOWED_FROM: Record<Decision, ApprovalValue[]> = {
  APPROVED: ['PENDING', 'REJECTED'],
  REJECTED: ['PENDING', 'APPROVED'],
};

function alreadyMessage(noun: string, status: Decision): string {
  return `This ${noun} is already ${status.toLowerCase()}`;
}

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

  const { status } = parsed.data;

  const clinic = await prisma.clinic.findUnique({
    where: { id: params.data.id },
    select: { id: true, approvalStatus: true },
  });

  if (!clinic) {
    res.status(404).json({ error: 'Clinic not found' });
    return;
  }

  if (clinic.approvalStatus === status) {
    res.status(409).json({ error: alreadyMessage('clinic', status) });
    return;
  }

  if (status === 'REJECTED' && clinic.approvalStatus === 'APPROVED') {
    const booked = await prisma.appointment.count({
      where: { status: 'BOOKED', doctor: { clinicId: clinic.id } },
    });

    if (booked > 0) {
      res.status(409).json({
        error:
          'Doctors at this clinic still have booked appointments. Those must be cancelled or completed before approval can be revoked.',
      });
      return;
    }
  }

  const result = await prisma.clinic.updateMany({
    where: { id: clinic.id, approvalStatus: { in: ALLOWED_FROM[status] } },
    data: { approvalStatus: status },
  });

  if (result.count === 0) {
    res.status(409).json({
      error: 'This clinic was changed by someone else. Refresh and try again.',
    });
    return;
  }

  const updated = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinic.id },
  });
  res.json(updated);
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

  const { status } = parsed.data;

  const doctor = await prisma.doctor.findUnique({
    where: { id: params.data.id },
    select: {
      id: true,
      approvalStatus: true,
      clinic: { select: { adminUserId: true, approvalStatus: true } },
    },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  const isOwningClinicAdmin =
    req.user!.role === 'CLINIC_ADMIN' &&
    doctor.clinic.adminUserId === req.user!.id &&
    doctor.clinic.approvalStatus === 'APPROVED';

  if (!isOwningClinicAdmin && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Not authorized to approve this doctor' });
    return;
  }

  if (doctor.approvalStatus === status) {
    res.status(409).json({ error: alreadyMessage('doctor', status) });
    return;
  }

  if (status === 'REJECTED' && doctor.approvalStatus === 'APPROVED') {
    const booked = await prisma.appointment.count({
      where: { doctorId: doctor.id, status: 'BOOKED' },
    });

    if (booked > 0) {
      res.status(409).json({
        error:
          'This doctor still has booked appointments. They must be cancelled or completed before approval can be revoked.',
      });
      return;
    }
  }

  const result = await prisma.doctor.updateMany({
    where: { id: doctor.id, approvalStatus: { in: ALLOWED_FROM[status] } },
    data: { approvalStatus: status },
  });

  if (result.count === 0) {
    res.status(409).json({
      error: 'This doctor was changed by someone else. Refresh and try again.',
    });
    return;
  }

  const updated = await prisma.doctor.findUniqueOrThrow({
    where: { id: doctor.id },
  });
  res.json(updated);
}

export async function listAdminClinics(
  req: AuthenticatedRequest,
  res: Response,
) {
  const query = adminListQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const { status, page, pageSize } = query.data;
  const where: Prisma.ClinicWhereInput = status
    ? { approvalStatus: status }
    : {};

  const [total, clinics] = await Promise.all([
    prisma.clinic.count({ where }),
    prisma.clinic.findMany({
      where,
      select: {
        id: true,
        name: true,
        address: true,
        approvalStatus: true,
        createdAt: true,
        adminUser: { select: { name: true, email: true } },
      },
      orderBy: [
        { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const counts = await prisma.doctor.groupBy({
    by: ['clinicId'],
    where: {
      clinicId: { in: clinics.map(clinic => clinic.id) },
      approvalStatus: 'APPROVED',
    },
    _count: { _all: true },
  });
  const countByClinic = new Map(
    counts.map(row => [row.clinicId, row._count._all]),
  );

  res.json({
    data: clinics.map(clinic => ({
      ...clinic,
      doctorCount: countByClinic.get(clinic.id) ?? 0,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function listAdminDoctors(
  req: AuthenticatedRequest,
  res: Response,
) {
  const query = adminListQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const { status, page, pageSize } = query.data;
  const where: Prisma.DoctorWhereInput = status
    ? { approvalStatus: status }
    : {};

  if (req.user!.role === 'CLINIC_ADMIN') {
    const clinic = await prisma.clinic.findUnique({
      where: { adminUserId: req.user!.id },
      select: { id: true },
    });

    if (!clinic) {
      res.status(404).json({ error: 'Clinic profile not found' });
      return;
    }

    where.clinicId = clinic.id;
  }

  const [total, doctors] = await Promise.all([
    prisma.doctor.count({ where }),
    prisma.doctor.findMany({
      where,
      select: {
        id: true,
        specialty: true,
        consultationFee: true,
        approvalStatus: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        clinic: { select: { id: true, name: true } },
      },
      orderBy: [
        { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({
    data: doctors.map(doctor => ({
      ...doctor,
      consultationFee: Number(doctor.consultationFee),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  });
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
  const [
    approvedClinics,
    approvedDoctors,
    patients,
    totalBookings,
    revenue,
    pendingClinics,
    pendingDoctors,
  ] = await Promise.all([
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
    prisma.clinic.count({ where: { approvalStatus: 'PENDING' } }),
    prisma.doctor.count({ where: { approvalStatus: 'PENDING' } }),
  ]);

  res.json({
    approvedClinics,
    approvedDoctors,
    patients,
    totalBookings,
    totalRevenue: Number(revenue._sum.amount ?? 0),
    pendingClinics,
    pendingDoctors,
  });
}
