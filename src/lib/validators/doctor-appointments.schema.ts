import { z } from 'zod';

export const listDoctorAppointmentsQuerySchema = z.object({
  scope: z.enum(['schedule', 'history']).default('schedule'),
  status: z.enum(['COMPLETED', 'NO_SHOW', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
