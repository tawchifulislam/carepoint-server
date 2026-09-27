import { addMinutes, isBefore } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { prisma } from '../lib/prisma.js';

const CLINIC_TIMEZONE = 'Asia/Dhaka';

interface Slot {
  start: string;
  end: string;
}

interface DaySlots {
  date: string;
  slots: Slot[];
}

function parseDateKey(dateKey: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = dateKey.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  return { year, month, day };
}

function toUtcInstant(dateKey: string, time: string): Date {
  return fromZonedTime(`${dateKey}T${time}:00`, CLINIC_TIMEZONE);
}

function getWeekday(dateKey: string): number {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

export async function getAvailableSlots(
  doctorId: string,
  fromDateKey: string,
  toDateKey: string,
): Promise<DaySlots[]> {
  const rangeStart = toUtcInstant(fromDateKey, '00:00');
  const rangeEnd = toUtcInstant(toDateKey, '23:59');

  const [availability, exceptions, appointments] = await Promise.all([
    prisma.availability.findMany({ where: { doctorId } }),
    prisma.availabilityException.findMany({
      where: {
        doctorId,
        date: { gte: rangeStart, lte: rangeEnd },
        isBlocked: true,
      },
    }),
    prisma.appointment.findMany({
      where: {
        doctorId,
        slotStart: { gte: rangeStart, lte: rangeEnd },
        status: { in: ['BOOKED', 'COMPLETED'] },
      },
      select: { slotStart: true },
    }),
  ]);

  const blockedDates = new Set(
    exceptions.map(e => e.date.toISOString().slice(0, 10)),
  );
  const takenSlots = new Set(appointments.map(a => a.slotStart.toISOString()));
  const now = new Date();
  const days: DaySlots[] = [];

  for (
    let dateKey = fromDateKey;
    dateKey <= toDateKey;
    dateKey = nextDateKey(dateKey)
  ) {
    if (blockedDates.has(dateKey)) {
      days.push({ date: dateKey, slots: [] });
      continue;
    }

    const weekday = getWeekday(dateKey);
    const dayRules = availability.filter(a => a.weekday === weekday);
    const slots: Slot[] = [];

    for (const rule of dayRules) {
      const step = rule.slotDurationMin + rule.bufferMin;
      let current = toUtcInstant(dateKey, rule.startTime);
      const end = toUtcInstant(dateKey, rule.endTime);

      while (addMinutes(current, rule.slotDurationMin) <= end) {
        const slotEnd = addMinutes(current, rule.slotDurationMin);

        if (!takenSlots.has(current.toISOString()) && !isBefore(current, now)) {
          slots.push({
            start: current.toISOString(),
            end: slotEnd.toISOString(),
          });
        }

        current = addMinutes(current, step);
      }
    }

    days.push({ date: dateKey, slots });
  }

  return days;
}
