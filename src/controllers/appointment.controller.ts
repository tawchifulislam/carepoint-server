import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import {
  createAppointmentSchema,
  listAppointmentsQuerySchema,
  rescheduleAppointmentSchema,
} from '../lib/validators/appointment.schema.js';
import {
  getAvailableSlots,
  reserveAppointment,
  SlotUnavailableError,
  toDhakaDateKey,
} from '../services/scheduling.service.js';
import {
  createPaymentSession,
  refundAppointmentPayment,
} from '../services/payment.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const CANCELLATION_CUTOFF_MS = 2 * 60 * 60 * 1000;

const appointmentDoctorSelect = {
  id: true,
  specialty: true,
  user: { select: { name: true } },
  clinic: { select: { name: true, address: true } },
} satisfies Prisma.DoctorSelect;

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
    const appointment = await reserveAppointment(
      parsed.data.doctorId,
      req.user!.id,
      parsed.data.slotStart,
    );

    const doctor = await prisma.doctor.findUniqueOrThrow({
      where: { id: parsed.data.doctorId },
    });
    const checkoutUrl = await createPaymentSession(appointment, doctor);

    res.status(201).json({ appointment, checkoutUrl });
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
  const query = listAppointmentsQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const { status, page, pageSize } = query.data;
  const where: Prisma.AppointmentWhereInput = { patientId: req.user!.id };

  if (status) {
    where.status = status;
  }

  const [total, appointments] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      select: {
        id: true,
        status: true,
        slotStart: true,
        slotEnd: true,
        doctor: { select: appointmentDoctorSelect },
      },
      orderBy: { slotStart: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({
    data: appointments,
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function getAppointment(req: AuthenticatedRequest, res: Response) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: params.data.id },
    select: {
      id: true,
      doctorId: true,
      patientId: true,
      status: true,
      slotStart: true,
      slotEnd: true,
      patient: { select: { name: true } },
      doctor: { select: { ...appointmentDoctorSelect, userId: true } },
    },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  const isOwner = appointment.patientId === req.user!.id;
  const isDoctor = appointment.doctor.userId === req.user!.id;

  if (!isOwner && !isDoctor && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Not authorized to view this appointment' });
    return;
  }

  res.json({
    id: appointment.id,
    doctorId: appointment.doctorId,
    status: appointment.status,
    slotStart: appointment.slotStart,
    slotEnd: appointment.slotEnd,
    patient: appointment.patient,
    doctor: {
      specialty: appointment.doctor.specialty,
      user: appointment.doctor.user,
      clinic: appointment.doctor.clinic,
    },
  });
}

export async function cancelAppointment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: params.data.id },
    include: { payment: true },
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

  if (appointment.status !== 'BOOKED') {
    res
      .status(409)
      .json({ error: 'Only booked appointments can be cancelled' });
    return;
  }

  if (appointment.slotStart.getTime() - Date.now() < CANCELLATION_CUTOFF_MS) {
    res
      .status(400)
      .json({ error: 'Cannot cancel within 2 hours of the appointment' });
    return;
  }

  const result = await prisma.appointment.updateMany({
    where: { id: appointment.id, status: 'BOOKED' },
    data: { status: 'CANCELLED' },
  });

  if (result.count === 0) {
    res
      .status(409)
      .json({ error: 'Appointment was changed by another request' });
    return;
  }

  if (appointment.payment?.status === 'SUCCEEDED') {
    await refundAppointmentPayment(
      appointment.id,
      appointment.payment.stripePaymentIntentId,
    );
  }

  const updated = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointment.id },
  });
  res.json(updated);
}

export async function rescheduleAppointment(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const parsedBody = rescheduleAppointmentSchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.flatten() });
    return;
  }

  const appointment = await prisma.appointment.findUnique({
    where: { id: params.data.id },
    include: { payment: true },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (appointment.patientId !== req.user!.id) {
    res
      .status(403)
      .json({ error: 'Not authorized to reschedule this appointment' });
    return;
  }

  if (appointment.status !== 'BOOKED') {
    res
      .status(409)
      .json({ error: 'Only booked appointments can be rescheduled' });
    return;
  }

  if (appointment.slotStart.getTime() - Date.now() < CANCELLATION_CUTOFF_MS) {
    res
      .status(400)
      .json({ error: 'Cannot reschedule within 2 hours of the appointment' });
    return;
  }

  const newSlotStart = parsedBody.data.slotStart;
  const dateKey = toDhakaDateKey(new Date(newSlotStart));
  const days = await getAvailableSlots(appointment.doctorId, dateKey, dateKey);
  const matchedSlot = days[0]?.slots.find(
    slot => slot.start === new Date(newSlotStart).toISOString(),
  );

  if (!matchedSlot) {
    res.status(409).json({ error: 'The requested slot is not available' });
    return;
  }

  try {
    const rescheduled = await prisma.$transaction(async tx => {
      const cancelled = await tx.appointment.updateMany({
        where: { id: appointment.id, status: 'BOOKED' },
        data: { status: 'CANCELLED' },
      });

      if (cancelled.count === 0) {
        throw new Error('CONCURRENT_MODIFICATION');
      }

      const newAppointment = await tx.appointment.create({
        data: {
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          slotStart: new Date(matchedSlot.start),
          slotEnd: new Date(matchedSlot.end),
          status: 'BOOKED',
        },
      });

      if (appointment.payment) {
        await tx.payment.update({
          where: { id: appointment.payment.id },
          data: { appointmentId: newAppointment.id },
        });
      }

      return newAppointment;
    });

    res.json(rescheduled);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      res
        .status(409)
        .json({ error: 'This slot was just booked by someone else' });
      return;
    }
    if (error instanceof Error && error.message === 'CONCURRENT_MODIFICATION') {
      res
        .status(409)
        .json({ error: 'Appointment was changed by another request' });
      return;
    }
    throw error;
  }
}
