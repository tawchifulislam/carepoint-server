import { Cron } from 'croner';
import { prisma } from '../lib/prisma.js';
import {
  CHECKOUT_EXPIRY_SECONDS,
  reconcilePayment,
  releaseUnpaidBooking,
} from './payment.service.js';
import { notifyBookingConfirmed } from './email.service.js';

const GRACE_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = CHECKOUT_EXPIRY_SECONDS * 1000 + GRACE_MS;
const PAGE_SIZE = 50;
const MAX_PER_SWEEP = 200;

export interface SweepResult {
  confirmed: number;
  released: number;
  failed: number;
}

export async function sweepStalePendingPayments(
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = { confirmed: 0, released: 0, failed: 0 };
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);

  let cursor: string | undefined;
  let processed = 0;

  while (processed < MAX_PER_SWEEP) {
    const page = await prisma.appointment.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: staleBefore } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const last = page.at(-1);

    if (!last) {
      break;
    }

    for (const { id } of page) {
      try {
        const outcome = await reconcilePayment(id);

        if (outcome === 'confirmed') {
          result.confirmed += 1;
          await notifyBookingConfirmed(id);
          continue;
        }

        if (outcome === 'released') {
          result.released += 1;
          continue;
        }

        const payment = await prisma.payment.findUnique({
          where: { appointmentId: id },
          select: { id: true },
        });

        if (!payment && (await releaseUnpaidBooking(id))) {
          result.released += 1;
        }
      } catch (error) {
        result.failed += 1;
        console.error('Payment sweep failed for appointment', id, error);
      }
    }

    processed += page.length;
    cursor = last.id;
  }

  return result;
}

function runSafely(): void {
  sweepStalePendingPayments()
    .then(result => {
      if (result.confirmed + result.released + result.failed > 0) {
        console.log('Payment sweep finished', result);
      }
    })
    .catch(error => console.error('Payment sweep run failed', error));
}

export function startPaymentSweepScheduler(): void {
  runSafely();

  new Cron('*/10 * * * *', { protect: true }, runSafely);
}
