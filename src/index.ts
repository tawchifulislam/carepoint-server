import 'dotenv/config';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import { clinicRoutes } from './routes/clinic.routes.js';
import { doctorRoutes } from './routes/doctor.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import cors from 'cors';

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL ?? 'http://localhost:3000',
    credentials: true,
  }),
);

app.all('/api/auth/*splat', toNodeHandler(auth));

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/clinics', clinicRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/admin', adminRoutes);

const PORT = process.env.PORT ?? 4000;

app.listen(PORT, () => {
  console.log(`CarePoint server running on port ${PORT}`);
});
