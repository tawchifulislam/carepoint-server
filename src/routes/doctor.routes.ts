import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, requireApproved } from '../middlewares/authorize.js';
import {
  applyAsDoctor,
  setAvailability,
  getDoctorAvailability,
} from '../controllers/doctor.controller.js';

export const doctorRoutes = Router();

doctorRoutes.post('/', authenticate, applyAsDoctor);
doctorRoutes.post(
  '/me/availability',
  authenticate,
  requireRole('DOCTOR'),
  requireApproved,
  setAvailability,
);
doctorRoutes.get('/:id/availability', getDoctorAvailability);
