import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { createClinicSchema } from '../lib/validators/clinic.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

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
