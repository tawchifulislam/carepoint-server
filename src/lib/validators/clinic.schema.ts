import { z } from 'zod';

export const createClinicSchema = z.object({
  name: z.string().min(2).max(120),
  address: z.string().min(5).max(255),
});
