import type { Response } from 'express';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listDoctorAppointmentsQuerySchema } from '../lib/validators/doctor-appointments.schema.js';
import type { AuthenticatedRequest } from '../middlewares/authenticate.js';

const HISTORY_STATUSES: AppointmentStatus[] = [
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

export async function listDoctorAppointments(
  req: AuthenticatedRequest,
  res: Response,
) {
  const query = listDoctorAppointmentsQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.flatten() });
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

  const { scope, status, page, pageSize } = query.data;

  const where: Prisma.AppointmentWhereInput = {
    doctorId: doctor.id,
    status:
      scope === 'schedule' ? 'BOOKED' : (status ?? { in: HISTORY_STATUSES }),
  };

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
      orderBy: [
        { slotStart: scope === 'schedule' ? 'asc' : 'desc' },
        { id: 'asc' },
      ],
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
