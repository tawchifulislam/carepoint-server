import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import { clinicRoutes } from './routes/clinic.routes.js';
import { doctorRoutes } from './routes/doctor.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { appointmentRoutes } from './routes/appointment.routes.js';
import { paymentRoutes } from './routes/payment.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_URL ?? 'http://localhost:3000',
    credentials: true,
  }),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth', authLimiter);
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use('/api/payments', paymentRoutes);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/clinics', clinicRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/me', userRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
