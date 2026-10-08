import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { availabilityQuerySchema } from '../lib/validators/availability.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import {
  createDoctorSchema,
  listDoctorsQuerySchema,
} from '../lib/validators/doctor.schema.js';
import {
  getAvailableSlots,
  getNextAvailableSlots,
} from '../services/scheduling.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const publiclyVisible = {
  approvalStatus: 'APPROVED',
  clinic: { approvalStatus: 'APPROVED' },
} satisfies Prisma.DoctorWhereInput;

const publicDoctorSelect = {
  id: true,
  specialty: true,
  consultationFee: true,
  bio: true,
  user: { select: { name: true, image: true } },
  clinic: { select: { id: true, name: true, address: true } },
} satisfies Prisma.DoctorSelect;

type PublicDoctor = Prisma.DoctorGetPayload<{
  select: typeof publicDoctorSelect;
}>;

function toPublicDoctor(doctor: PublicDoctor) {
  return {
    id: doctor.id,
    name: doctor.user.name,
    image: doctor.user.image,
    specialty: doctor.specialty,
    consultationFee: Number(doctor.consultationFee),
    bio: doctor.bio,
    clinic: doctor.clinic,
  };
}

export async function applyAsDoctor(req: AuthenticatedRequest, res: Response) {
  const parsed = createDoctorSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: parsed.data.clinicId },
  });

  if (!clinic || clinic.approvalStatus !== 'APPROVED') {
    res.status(400).json({ error: 'Clinic not found or not approved' });
    return;
  }

  const existing = await prisma.doctor.findUnique({
    where: { userId: req.user!.id },
  });

  if (existing) {
    res.status(409).json({ error: 'You have already registered as a doctor' });
    return;
  }

  const doctor = await prisma.doctor.create({
    data: {
      userId: req.user!.id,
      clinicId: parsed.data.clinicId,
      specialty: parsed.data.specialty,
      consultationFee: parsed.data.consultationFee,
      bio: parsed.data.bio,
    },
  });

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { role: 'DOCTOR' },
  });

  res.status(201).json(doctor);
}

export async function listDoctors(req: Request, res: Response) {
  const query = listDoctorsQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const { search, specialty, page, pageSize } = query.data;

  const filters: Prisma.DoctorWhereInput[] = [publiclyVisible];

  if (specialty) {
    filters.push({ specialty: { equals: specialty, mode: 'insensitive' } });
  }

  if (search) {
    filters.push({
      OR: [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { specialty: { contains: search, mode: 'insensitive' } },
        { clinic: { name: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }

  const where: Prisma.DoctorWhereInput = { AND: filters };

  const [total, doctors] = await Promise.all([
    prisma.doctor.count({ where }),
    prisma.doctor.findMany({
      where,
      select: publicDoctorSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const nextSlots = await getNextAvailableSlots(
    doctors.map(doctor => doctor.id),
  );

  res.json({
    data: doctors.map(doctor => ({
      ...toPublicDoctor(doctor),
      nextAvailableSlot: nextSlots.get(doctor.id) ?? null,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function getDoctor(req: Request, res: Response) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid doctor id' });
    return;
  }

  const doctor = await prisma.doctor.findFirst({
    where: { id: params.data.id, ...publiclyVisible },
    select: publicDoctorSelect,
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  res.json(toPublicDoctor(doctor));
}

export async function getDoctorAvailability(req: Request, res: Response) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid doctor id' });
    return;
  }

  const query = availabilityQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const doctor = await prisma.doctor.findFirst({
    where: { id: params.data.id, ...publiclyVisible },
    select: { id: true },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  const days = await getAvailableSlots(
    doctor.id,
    query.data.from,
    query.data.to,
  );

  res.json(days);
}
