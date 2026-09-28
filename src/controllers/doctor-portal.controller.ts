import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  createAvailabilitySchema,
  createExceptionSchema,
} from '../lib/validators/availability.schema.js';
import {
  listAppointmentsQuerySchema,
  updateAppointmentStatusSchema,
} from '../lib/validators/appointment.schema.js';
import { idParamsSchema } from '../lib/validators/common.schema.js';
import { getDayRange, toDhakaDateKey } from '../services/scheduling.service.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

async function findDoctorProfile(req: AuthenticatedRequest, res: Response) {
  const doctor = await prisma.doctor.findUnique({
    where: { userId: req.user!.id },
  });

  if (!doctor) {
    res.status(404).json({ error: 'Doctor profile not found' });
  }

  return doctor;
}

export async function createAvailabilityRule(
  req: AuthenticatedRequest,
  res: Response,
) {
  const parsed = createAvailabilitySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const sameWeekday = await prisma.availability.findMany({
    where: { doctorId: doctor.id, weekday: parsed.data.weekday },
  });

  const overlaps = sameWeekday.some(
    rule =>
      parsed.data.startTime < rule.endTime &&
      rule.startTime < parsed.data.endTime,
  );

  if (overlaps) {
    res.status(409).json({
      error: 'This time window overlaps an existing availability rule',
    });
    return;
  }

  const rule = await prisma.availability.create({
    data: { ...parsed.data, doctorId: doctor.id },
  });

  res.status(201).json(rule);
}

export async function listMyAvailability(
  req: AuthenticatedRequest,
  res: Response,
) {
  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const rules = await prisma.availability.findMany({
    where: { doctorId: doctor.id },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  });

  res.json(rules);
}

export async function deleteMyAvailability(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid availability id' });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const result = await prisma.availability.deleteMany({
    where: { id: params.data.id, doctorId: doctor.id },
  });

  if (result.count === 0) {
    res.status(404).json({ error: 'Availability rule not found' });
    return;
  }

  res.status(204).send();
}

export async function listMyAppointments(
  req: AuthenticatedRequest,
  res: Response,
) {
  const query = listAppointmentsQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const { status, page, pageSize } = query.data;
  const where: Prisma.AppointmentWhereInput = { doctorId: doctor.id };

  if (status) {
    where.status = status;
  }

  const [total, appointments] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      select: {
        id: true,
        slotStart: true,
        slotEnd: true,
        status: true,
        patient: { select: { name: true } },
      },
      orderBy: { slotStart: 'asc' },
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

export async function updateMyAppointmentStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid appointment id' });
    return;
  }

  const parsedBody = updateAppointmentStatusSchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.flatten() });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: params.data.id, doctorId: doctor.id },
  });

  if (!appointment) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (appointment.status !== 'BOOKED') {
    res.status(409).json({ error: 'Only booked appointments can be updated' });
    return;
  }

  if (appointment.slotStart.getTime() > Date.now()) {
    res
      .status(400)
      .json({ error: 'Cannot update an appointment before it starts' });
    return;
  }

  const result = await prisma.appointment.updateMany({
    where: { id: appointment.id, doctorId: doctor.id, status: 'BOOKED' },
    data: { status: parsedBody.data.status },
  });

  if (result.count === 0) {
    res
      .status(409)
      .json({ error: 'Appointment was changed by another request' });
    return;
  }

  const updated = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointment.id },
  });

  res.json(updated);
}

export async function listMyExceptions(
  req: AuthenticatedRequest,
  res: Response,
) {
  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const exceptions = await prisma.availabilityException.findMany({
    where: {
      doctorId: doctor.id,
      date: { gte: new Date(toDhakaDateKey(new Date())) },
    },
    orderBy: { date: 'asc' },
  });

  res.json(
    exceptions.map(e => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
    })),
  );
}

export async function createException(
  req: AuthenticatedRequest,
  res: Response,
) {
  const parsed = createExceptionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { date } = parsed.data;

  if (date < toDhakaDateKey(new Date())) {
    res.status(400).json({ error: 'Cannot block a past date' });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const { start, end } = getDayRange(date);

  const activeCount = await prisma.appointment.count({
    where: {
      doctorId: doctor.id,
      slotStart: { gte: start, lt: end },
      status: { in: ['PENDING_PAYMENT', 'BOOKED'] },
    },
  });

  if (activeCount > 0) {
    res.status(409).json({
      error: 'Cancel or reschedule existing appointments for this day first',
    });
    return;
  }

  try {
    const exception = await prisma.availabilityException.create({
      data: { doctorId: doctor.id, date: new Date(date), isBlocked: true },
    });

    res.status(201).json({ id: exception.id, date });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      res.status(409).json({ error: 'This date is already blocked' });
      return;
    }
    throw error;
  }
}

export async function deleteException(
  req: AuthenticatedRequest,
  res: Response,
) {
  const params = idParamsSchema.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: 'Invalid exception id' });
    return;
  }

  const doctor = await findDoctorProfile(req, res);

  if (!doctor) {
    return;
  }

  const result = await prisma.availabilityException.deleteMany({
    where: { id: params.data.id, doctorId: doctor.id },
  });

  if (result.count === 0) {
    res.status(404).json({ error: 'Exception not found' });
    return;
  }

  res.status(204).send();
}
