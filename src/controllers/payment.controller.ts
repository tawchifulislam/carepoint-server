import type { Request, Response } from 'express';
import { stripe } from '../lib/stripe.js';
import { prisma } from '../lib/prisma.js';

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
    const paymentIntentId = session.payment_intent as string;

    if (appointmentId) {
      await prisma.$transaction([
        prisma.appointment.update({
          where: { id: appointmentId },
          data: { status: 'BOOKED' },
        }),
        prisma.payment.update({
          where: { appointmentId },
          data: { status: 'SUCCEEDED', stripePaymentIntentId: paymentIntentId },
        }),
      ]);
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
