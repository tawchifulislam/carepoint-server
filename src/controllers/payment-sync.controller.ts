import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import { reconcilePayment } from '../services/payment.service.js';
import { notifyBookingConfirmed } from '../services/email.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

export async function syncPayment(req: AuthenticatedRequest, res: Response) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: params.data.id },
    select: { id: true, patientId: true, status: true },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (appointment.patientId !== req.user!.id) {
    res.status(403).json({ error: 'Not authorized to sync this payment' });
    return;
  }

  if (appointment.status === 'PENDING_PAYMENT') {
    const outcome = await reconcilePayment(appointment.id);

    if (outcome === 'confirmed') {
      await notifyBookingConfirmed(appointment.id);
    }
  }

  const current = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointment.id },
    select: { status: true },
  });

  res.json({ status: current.status });
}
