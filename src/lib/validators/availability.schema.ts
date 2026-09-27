import { z } from 'zod';

export const createAvailabilitySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm format'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm format'),
  slotDurationMin: z.number().int().positive(),
  bufferMin: z.number().int().min(0).default(0),
});

export const availabilityQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
});
