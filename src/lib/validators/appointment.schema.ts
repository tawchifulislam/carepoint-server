import { z } from 'zod';

export const createAppointmentSchema = z.object({
  doctorId: z.string().cuid(),
  slotStart: z.string().datetime(),
});

export const updateAppointmentStatusSchema = z.object({
  status: z.enum(['COMPLETED', 'NO_SHOW']),
});

export const listAppointmentsQuerySchema = z.object({
  status: z
    .enum(['PENDING_PAYMENT', 'BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
