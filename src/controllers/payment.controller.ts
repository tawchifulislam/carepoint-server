import type { Request, Response } from 'express';
import { stripe } from '../lib/stripe.js';
import { prisma } from '../lib/prisma.js';
import { confirmBooking } from '../services/payment.service.js';
import { notifyBookingConfirmed } from '../services/email.service.js';

export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    res.status(400).send('Missing Stripe signature');
    return;
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const appointmentId = session.metadata?.appointmentId;
    const paymentIntentId = session.payment_intent;

    if (appointmentId && typeof paymentIntentId === 'string') {
      const confirmed = await confirmBooking(appointmentId, paymentIntentId);

      if (confirmed) {
        await notifyBookingConfirmed(appointmentId);
      }
    }
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const appointmentId = session.metadata?.appointmentId;

    if (appointmentId) {
      await prisma.$transaction([
        prisma.appointment.update({
          where: { id: appointmentId },
          data: { status: 'CANCELLED' },
        }),
        prisma.payment.update({
          where: { appointmentId },
          data: { status: 'FAILED' },
        }),
      ]);
    }
  }

  res.json({ received: true });
}
