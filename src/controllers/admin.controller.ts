import type { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { approvalDecisionSchema } from '../lib/validators/approval.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const paramsSchema = z.object({ id: z.string().cuid() });

export async function decideClinicApproval(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = paramsSchema.safeParse(req.params);

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
  const params = paramsSchema.safeParse(req.params);

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
