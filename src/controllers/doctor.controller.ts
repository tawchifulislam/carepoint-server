import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createDoctorSchema } from '../lib/validators/doctor.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

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
