import type { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { createAppointmentSchema } from '../lib/validators/appointment.schema.js';
import {
  bookAppointment,
  SlotUnavailableError,
} from '../services/scheduling.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const paramsSchema = z.object({ id: z.string().cuid() });
const CANCELLATION_CUTOFF_MS = 2 * 60 * 60 * 1000;

export async function createAppointment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const parsed = createAppointmentSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const appointment = await bookAppointment(
      parsed.data.doctorId,
      req.user!.id,
      parsed.data.slotStart,
    );
    res.status(201).json(appointment);
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function getMyAppointments(
  req: AuthenticatedRequest,
  res: Response,
) {
  const appointments = await prisma.appointment.findMany({
    where: { patientId: req.user!.id },
    include: { doctor: { include: { clinic: true } } },
    orderBy: { slotStart: 'asc' },
  });

  res.json(appointments);
}

export async function cancelAppointment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = paramsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: params.data.id },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (appointment.patientId !== req.user!.id) {
    res
      .status(403)
      .json({ error: 'Not authorized to cancel this appointment' });
    return;
  }

  if (appointment.slotStart.getTime() - Date.now() < CANCELLATION_CUTOFF_MS) {
    res
      .status(400)
      .json({ error: 'Cannot cancel within 2 hours of the appointment' });
    return;
  }

  const updated = await prisma.appointment.update({
    where: { id: params.data.id },
    data: { status: 'CANCELLED' },
  });

  res.json(updated);
}
