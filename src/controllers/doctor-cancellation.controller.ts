import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import {
  cancelBookedAppointment,
  RefundFailedError,
} from '../services/appointment-cancellation.service.js';
import { notifyAppointmentCancelledByDoctor } from '../services/email.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

export async function cancelDoctorAppointment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const doctor = await prisma.doctor.findUnique({
    where: { userId: req.user!.id },
    select: { id: true },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor profile not found' });
    return;
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: params.data.id, doctorId: doctor.id },
    select: { id: true, status: true, slotStart: true },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (appointment.status !== 'BOOKED') {
    res
      .status(409)
      .json({ error: 'Only booked appointments can be cancelled' });
    return;
  }

  if (appointment.slotStart.getTime() <= Date.now()) {
    res.status(400).json({
      error:
        'This appointment has already started. Mark it as completed or no-show instead.',
    });
    return;
  }

  let refunded = false;

  try {
    const result = await cancelBookedAppointment(appointment.id);

    if (!result.cancelled) {
      res
        .status(409)
        .json({ error: 'Appointment was changed by another request' });
      return;
    }

    refunded = result.refunded;
  } catch (error) {
    if (error instanceof RefundFailedError) {
      res.status(502).json({
        error:
          'The refund could not be processed, so the appointment was not cancelled. Please try again.',
      });
      return;
    }
    throw error;
  }

  await notifyAppointmentCancelledByDoctor(appointment.id, refunded);

  res.json({ id: appointment.id, status: 'CANCELLED', refunded });
}
