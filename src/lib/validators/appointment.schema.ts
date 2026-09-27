import { z } from 'zod';

export const createAppointmentSchema = z.object({
  doctorId: z.string().cuid(),
  slotStart: z.string().datetime(),
});
