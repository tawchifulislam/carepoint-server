import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole } from '../middlewares/authorize.js';
import {
  decideClinicApproval,
  decideDoctorApproval,
  getPlatformMetrics,
  listPendingClinics,
  listPendingDoctors,
} from '../controllers/admin.controller.js';

export const adminRoutes = Router();

adminRoutes.use(authenticate);

adminRoutes.get(
  '/clinics/pending',
  requireRole('SUPER_ADMIN'),
  listPendingClinics,
);
adminRoutes.patch(
  '/clinics/:id/approval',
  requireRole('SUPER_ADMIN'),
  decideClinicApproval,
);
adminRoutes.get(
  '/doctors/pending',
  requireRole('SUPER_ADMIN', 'CLINIC_ADMIN'),
  listPendingDoctors,
);
adminRoutes.patch(
  '/doctors/:id/approval',
  requireRole('CLINIC_ADMIN', 'SUPER_ADMIN'),
  decideDoctorApproval,
);
adminRoutes.get('/metrics', requireRole('SUPER_ADMIN'), getPlatformMetrics);
