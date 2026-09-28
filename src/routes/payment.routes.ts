import { Router } from 'express';
import express from 'express';
import { handleStripeWebhook } from '../controllers/payment.controller.js';

export const paymentRoutes = Router();

paymentRoutes.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook,
);
