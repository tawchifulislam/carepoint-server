import { z } from 'zod';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm format');
const dateKey = z.string().date();

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export const createAvailabilitySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: timeOfDay,
    endTime: timeOfDay,
    slotDurationMin: z.number().int().min(5).max(240),
    bufferMin: z.number().int().min(0).max(120).default(0),
  })
  .refine(rule => rule.endTime > rule.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  })
  .refine(
    rule =>
      toMinutes(rule.endTime) - toMinutes(rule.startTime) >=
      rule.slotDurationMin,
    {
      message: 'The window is shorter than one slot',
      path: ['slotDurationMin'],
    },
  );

export const availabilityQuerySchema = z
  .object({ from: dateKey, to: dateKey })
  .refine(query => query.to >= query.from, {
    message: 'to must not be before from',
    path: ['to'],
  })
  .refine(
    query => (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 <= 31,
    {
      message: 'Range cannot exceed 31 days',
      path: ['to'],
    },
  );

export const createExceptionSchema = z.object({ date: dateKey });
