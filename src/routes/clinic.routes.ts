import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole } from '../middlewares/authorize.js';
import {
  applyAsClinicAdmin,
  getClinicDashboard,
  getMyClinic,
  listApprovedClinics,
  listMyClinicDoctors,
} from '../controllers/clinic.controller.js';

export const clinicRoutes = Router();

clinicRoutes.get('/', listApprovedClinics);
clinicRoutes.post(
  '/',
  authenticate,
  requireRole('PATIENT'),
  applyAsClinicAdmin,
);
clinicRoutes.get('/me', authenticate, requireRole('CLINIC_ADMIN'), getMyClinic);
clinicRoutes.get(
  '/me/doctors',
  authenticate,
  requireRole('CLINIC_ADMIN'),
  listMyClinicDoctors,
);
clinicRoutes.get(
  '/:id/dashboard',
  authenticate,
  requireRole('CLINIC_ADMIN', 'SUPER_ADMIN'),
  getClinicDashboard,
);
