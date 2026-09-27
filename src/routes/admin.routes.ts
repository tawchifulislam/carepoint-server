import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole } from '../middlewares/authorize.js';
import {
  decideClinicApproval,
  decideDoctorApproval,
} from '../controllers/admin.controller.js';

export const adminRoutes = Router();

adminRoutes.patch(
  '/clinics/:id/approval',
  authenticate,
  requireRole('SUPER_ADMIN'),
  decideClinicApproval,
);

adminRoutes.patch(
  '/doctors/:id/approval',
  authenticate,
  requireRole('CLINIC_ADMIN', 'SUPER_ADMIN'),
  decideDoctorApproval,
);
