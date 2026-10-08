import { addMinutes, isBefore } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { Prisma } from '@prisma/client';
import type { Appointment, AppointmentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const CLINIC_TIMEZONE = 'Asia/Dhaka';
const ACTIVE_STATUSES: AppointmentStatus[] = [
  'PENDING_PAYMENT',
  'BOOKED',
  'COMPLETED',
];
const NEXT_SLOT_WINDOW_DAYS = 14;

interface Slot {
  start: string;
  end: string;
}

interface DaySlots {
  date: string;
  slots: Slot[];
}

interface AvailabilityRule {
  weekday: number;
  startTime: string;
  endTime: string;
  slotDurationMin: number;
  bufferMin: number;
}

export class SlotUnavailableError extends Error {}

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

export function nextDateKey(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

export function toDhakaDateKey(date: Date): string {
  return formatInTimeZone(date, CLINIC_TIMEZONE, 'yyyy-MM-dd');
}

export function getDayRange(dateKey: string): { start: Date; end: Date } {
  return {
    start: toUtcInstant(dateKey, '00:00'),
    end: toUtcInstant(nextDateKey(dateKey), '00:00'),
  };
}

function buildDaySlots(
  rules: AvailabilityRule[],
  blockedDates: Set<string>,
  takenSlots: Set<string>,
  fromDateKey: string,
  toDateKey: string,
  now: Date,
): DaySlots[] {
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
    const dayRules = rules.filter(rule => rule.weekday === weekday);
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

    slots.sort((a, b) => a.start.localeCompare(b.start));
    days.push({ date: dateKey, slots });
  }

  return days;
}

export async function getAvailableSlots(
  doctorId: string,
  fromDateKey: string,
  toDateKey: string,
): Promise<DaySlots[]> {
  const rangeStart = getDayRange(fromDateKey).start;
  const rangeEnd = getDayRange(toDateKey).end;

  const [rules, exceptions, appointments] = await Promise.all([
    prisma.availability.findMany({ where: { doctorId } }),
    prisma.availabilityException.findMany({
      where: {
        doctorId,
        isBlocked: true,
        date: { gte: new Date(fromDateKey), lte: new Date(toDateKey) },
      },
    }),
    prisma.appointment.findMany({
      where: {
        doctorId,
        slotStart: { gte: rangeStart, lt: rangeEnd },
        status: { in: ACTIVE_STATUSES },
      },
      select: { slotStart: true },
    }),
  ]);

  const blockedDates = new Set(
    exceptions.map(e => e.date.toISOString().slice(0, 10)),
  );
  const takenSlots = new Set(appointments.map(a => a.slotStart.toISOString()));

  return buildDaySlots(
    rules,
    blockedDates,
    takenSlots,
    fromDateKey,
    toDateKey,
    new Date(),
  );
}

export async function getNextAvailableSlots(
  doctorIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();

  for (const id of doctorIds) {
    result.set(id, null);
  }

  if (doctorIds.length === 0) {
    return result;
  }

  const fromDateKey = toDhakaDateKey(new Date());
  let toDateKey = fromDateKey;

  for (let i = 1; i < NEXT_SLOT_WINDOW_DAYS; i++) {
    toDateKey = nextDateKey(toDateKey);
  }

  const rangeStart = getDayRange(fromDateKey).start;
  const rangeEnd = getDayRange(toDateKey).end;

  const [rules, exceptions, appointments] = await Promise.all([
    prisma.availability.findMany({ where: { doctorId: { in: doctorIds } } }),
    prisma.availabilityException.findMany({
      where: {
        doctorId: { in: doctorIds },
        isBlocked: true,
        date: { gte: new Date(fromDateKey), lte: new Date(toDateKey) },
      },
    }),
    prisma.appointment.findMany({
      where: {
        doctorId: { in: doctorIds },
        slotStart: { gte: rangeStart, lt: rangeEnd },
        status: { in: ACTIVE_STATUSES },
      },
      select: { doctorId: true, slotStart: true },
    }),
  ]);

  const now = new Date();

  for (const doctorId of doctorIds) {
    const doctorRules = rules.filter(rule => rule.doctorId === doctorId);

    if (doctorRules.length === 0) {
      continue;
    }

    const blockedDates = new Set(
      exceptions
        .filter(e => e.doctorId === doctorId)
        .map(e => e.date.toISOString().slice(0, 10)),
    );
    const takenSlots = new Set(
      appointments
        .filter(a => a.doctorId === doctorId)
        .map(a => a.slotStart.toISOString()),
    );

    const days = buildDaySlots(
      doctorRules,
      blockedDates,
      takenSlots,
      fromDateKey,
      toDateKey,
      now,
    );
    const firstSlot = days.flatMap(day => day.slots)[0];

    result.set(doctorId, firstSlot?.start ?? null);
  }

  return result;
}

export async function reserveAppointment(
  doctorId: string,
  patientId: string,
  slotStart: string,
): Promise<Appointment> {
  const slotInstant = new Date(slotStart);
  const normalizedStart = slotInstant.toISOString();

  const doctor = await prisma.doctor.findFirst({
    where: {
      id: doctorId,
      approvalStatus: 'APPROVED',
      clinic: { approvalStatus: 'APPROVED' },
    },
    select: { id: true },
  });

  if (!doctor) {
    throw new SlotUnavailableError('This doctor is not available for booking');
  }

  const dateKey = toDhakaDateKey(slotInstant);
  const days = await getAvailableSlots(doctorId, dateKey, dateKey);
  const matchedSlot = days[0]?.slots.find(
    slot => slot.start === normalizedStart,
  );

  if (!matchedSlot) {
    throw new SlotUnavailableError('This slot is no longer available');
  }

  try {
    return await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart: new Date(matchedSlot.start),
        slotEnd: new Date(matchedSlot.end),
        status: 'PENDING_PAYMENT',
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new SlotUnavailableError(
        'This slot was just booked by someone else',
      );
    }
    throw error;
  }
}
