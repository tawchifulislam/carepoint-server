import { z } from 'zod';

export const createDoctorSchema = z.object({
  clinicId: z.string().cuid(),
  specialty: z.string().min(2).max(120),
  consultationFee: z.number().positive(),
  bio: z.string().max(1000).optional(),
});
