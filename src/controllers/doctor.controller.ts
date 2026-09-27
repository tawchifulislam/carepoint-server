import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createDoctorSchema } from '../lib/validators/doctor.schema.js';
import {
  createAvailabilitySchema,
  availabilityQuerySchema,
} from '../lib/validators/availability.schema.js';
import { getAvailableSlots } from '../services/scheduling.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const paramsSchema = z.object({ id: z.string().cuid() });

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

export async function setAvailability(
  req: AuthenticatedRequest,
  res: Response,
) {
  const parsed = createAvailabilitySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const doctor = await prisma.doctor.findUnique({
    where: { userId: req.user!.id },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor profile not found' });
    return;
  }

  const availability = await prisma.availability.create({
    data: { ...parsed.data, doctorId: doctor.id },
  });

  res.status(201).json(availability);
}

export async function getDoctorAvailability(req: Request, res: Response) {
  const params = paramsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid doctor id' });
    return;
  }

  const query = availabilityQuerySchema.safeParse(req.query);

  if (!query.success) {
    res
      .status(400)
      .json({ error: 'from and to must be dates in YYYY-MM-DD format' });
    return;
  }

  const doctor = await prisma.doctor.findUnique({
    where: { id: params.data.id },
  });

  if (!doctor || doctor.approvalStatus !== 'APPROVED') {
    res.status(404).json({ error: 'Doctor not found' });
    return;
  }

  const days = await getAvailableSlots(
    params.data.id,
    query.data.from,
    query.data.to,
  );

  res.json(days);
}
