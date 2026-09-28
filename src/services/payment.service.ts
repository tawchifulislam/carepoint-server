import type { Appointment, Doctor } from '@prisma/client';
import { stripe } from '../lib/stripe.js';
import { prisma } from '../lib/prisma.js';

const CHECKOUT_EXPIRY_SECONDS = 30 * 60;

export async function createPaymentSession(
  appointment: Appointment,
  doctor: Doctor,
): Promise<string> {
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
