import { Cron } from 'croner';
import { prisma } from '../lib/prisma.js';
import { notifyAppointmentReminder } from './email.service.js';

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_BOOKING_AGE_MS = 60 * 60 * 1000;

export async function sendDueReminders(): Promise<void> {
  const now = Date.now();

  const due = await prisma.appointment.findMany({
    where: {
      status: 'BOOKED',
      reminderSentAt: null,
      slotStart: { gt: new Date(now), lte: new Date(now + REMINDER_WINDOW_MS) },
      createdAt: { lte: new Date(now - MIN_BOOKING_AGE_MS) },
    },
    select: { id: true },
  });

  for (const { id } of due) {
    const claimed = await prisma.appointment.updateMany({
      where: { id, reminderSentAt: null },
      data: { reminderSentAt: new Date() },
    });

    if (claimed.count === 1) {
      await notifyAppointmentReminder(id);
    }
  }
}

function runSafely(): void {
  sendDueReminders().catch(error =>
    console.error('Reminder run failed', error),
  );
}

export function startReminderScheduler(): void {
  runSafely();

  new Cron(
    '*/15 * * * *',
    { timezone: 'Asia/Dhaka', protect: true },
    runSafely,
  );
}
