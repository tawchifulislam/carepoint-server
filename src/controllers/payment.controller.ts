import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { stripe } from '../lib/stripe.js';
import { notifyBookingConfirmed } from '../services/email.service.js';
import {
  confirmBooking,
  releaseUnpaidBooking,
} from '../services/payment.service.js';

export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    res.status(400).send('Missing Stripe signature');
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string,
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
    const appointmentId = event.data.object.metadata?.appointmentId;

    if (appointmentId) {
      await releaseUnpaidBooking(appointmentId);
    }
  }

  res.json({ received: true });
}
