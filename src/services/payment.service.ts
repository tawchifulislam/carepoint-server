import type { Appointment, Doctor } from '@prisma/client';
import { stripe } from '../lib/stripe.js';
import { prisma } from '../lib/prisma.js';

export const CHECKOUT_EXPIRY_SECONDS = 30 * 60;

export type ReconcileOutcome = 'confirmed' | 'released' | 'unchanged';

export class PaymentSessionInactiveError extends Error {}

export async function createPaymentSession(
  appointment: Appointment,
  doctor: Doctor,
): Promise<string> {
  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(Number(doctor.consultationFee) * 100),
              product_data: { name: `Consultation - ${doctor.specialty}` },
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_URL}/appointments/${appointment.id}?status=success`,
        cancel_url: `${process.env.CLIENT_URL}/appointments/${appointment.id}?status=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_SECONDS,
        metadata: { appointmentId: appointment.id },
      },
      { idempotencyKey: `checkout-${appointment.id}` },
    );

    await prisma.payment.create({
      data: {
        appointment: { connect: { id: appointment.id } },
        stripePaymentIntentId: session.id,
        amount: doctor.consultationFee,
        status: 'PENDING',
      },
    });

    return session.url!;
  } catch (error) {
    await prisma.appointment
      .updateMany({
        where: { id: appointment.id, status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED' },
      })
      .catch(releaseError =>
        console.error(
          'Failed to release slot after checkout error',
          releaseError,
        ),
      );

    throw error;
  }
}

export async function getResumeCheckoutUrl(
  appointmentId: string,
): Promise<string> {
  const payment = await prisma.payment.findUnique({ where: { appointmentId } });

  if (!payment || !payment.stripePaymentIntentId.startsWith('cs_')) {
    throw new PaymentSessionInactiveError(
      'No active payment session for this appointment',
    );
  }

  const session = await stripe.checkout.sessions.retrieve(
    payment.stripePaymentIntentId,
  );

  if (session.status !== 'open' || !session.url) {
    throw new PaymentSessionInactiveError(
      'This payment session is no longer active',
    );
  }

  return session.url;
}

export async function confirmBooking(
  appointmentId: string,
  paymentIntentId: string,
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const updated = await tx.appointment.updateMany({
      where: { id: appointmentId, status: 'PENDING_PAYMENT' },
      data: { status: 'BOOKED' },
    });

    if (updated.count === 0) {
      return false;
    }

    await tx.payment.update({
      where: { appointmentId },
      data: { status: 'SUCCEEDED', stripePaymentIntentId: paymentIntentId },
    });

    return true;
  });
}

export async function releaseUnpaidBooking(
  appointmentId: string,
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const cancelled = await tx.appointment.updateMany({
      where: { id: appointmentId, status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED' },
    });

    if (cancelled.count === 0) {
      return false;
    }

    await tx.payment.updateMany({
      where: { appointmentId },
      data: { status: 'FAILED' },
    });

    return true;
  });
}

export async function reconcilePayment(
  appointmentId: string,
): Promise<ReconcileOutcome> {
  const payment = await prisma.payment.findUnique({ where: { appointmentId } });

  if (!payment || !payment.stripePaymentIntentId.startsWith('cs_')) {
    return 'unchanged';
  }

  const session = await stripe.checkout.sessions.retrieve(
    payment.stripePaymentIntentId,
  );

  if (
    session.payment_status === 'paid' &&
    typeof session.payment_intent === 'string'
  ) {
    const confirmed = await confirmBooking(
      appointmentId,
      session.payment_intent,
    );
    return confirmed ? 'confirmed' : 'unchanged';
  }

  if (session.status === 'expired') {
    const released = await releaseUnpaidBooking(appointmentId);
    return released ? 'released' : 'unchanged';
  }

  return 'unchanged';
}

export async function refundAppointmentPayment(
  appointmentId: string,
  stripePaymentIntentId: string,
): Promise<void> {
  await stripe.refunds.create({ payment_intent: stripePaymentIntentId });

  await prisma.payment.update({
    where: { appointmentId },
    data: { status: 'REFUNDED' },
  });
}
