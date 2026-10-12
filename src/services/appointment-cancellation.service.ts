import { prisma } from '../lib/prisma.js';
import { refundPaymentIntent } from './payment.service.js';

export class RefundFailedError extends Error {}

export interface CancelResult {
  cancelled: boolean;
  refunded: boolean;
}

export async function cancelBookedAppointment(
  appointmentId: string,
): Promise<CancelResult> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      status: true,
      payment: { select: { status: true, stripePaymentIntentId: true } },
    },
  });

  if (!appointment || appointment.status !== 'BOOKED') {
    return { cancelled: false, refunded: false };
  }

  const payment = appointment.payment;
  const needsRefund = payment?.status === 'SUCCEEDED';

  if (needsRefund && payment) {
    try {
      await refundPaymentIntent(appointmentId, payment.stripePaymentIntentId);
    } catch (error) {
      console.error('Refund failed for appointment', appointmentId, error);
      throw new RefundFailedError('The refund could not be processed');
    }
  }

  const cancelled = await prisma.$transaction(async tx => {
    const updated = await tx.appointment.updateMany({
      where: { id: appointmentId, status: 'BOOKED' },
      data: { status: 'CANCELLED' },
    });

    if (updated.count === 0) {
      return false;
    }

    if (needsRefund) {
      await tx.payment.update({
        where: { appointmentId },
        data: { status: 'REFUNDED' },
      });
    }

    return true;
  });

  return { cancelled, refunded: cancelled && needsRefund };
}
