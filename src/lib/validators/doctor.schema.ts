import { z } from 'zod';

const optionalText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform(value => (value ? value : undefined));

export const createDoctorSchema = z.object({
  clinicId: z.string().cuid(),
  specialty: z.string().min(2).max(120),
  consultationFee: z.number().positive(),
  bio: z.string().max(1000).optional(),
});

export const listDoctorsQuerySchema = z.object({
  search: optionalText,
  specialty: optionalText,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
