import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireApproved, requireRole } from '../middlewares/authorize.js';
import {
  applyAsDoctor,
  getDoctor,
  getDoctorAvailability,
  listDoctors,
} from '../controllers/doctor.controller.js';
import {
  createAvailabilityRule,
  createException,
  deleteException,
  deleteMyAvailability,
  listMyAppointments,
  listMyAvailability,
  listMyExceptions,
  updateMyAppointmentStatus,
} from '../controllers/doctor-portal.controller.js';

const portalRoutes = Router();

portalRoutes.use(authenticate, requireRole('DOCTOR'), requireApproved);
portalRoutes.get('/availability', listMyAvailability);
portalRoutes.post('/availability', createAvailabilityRule);
portalRoutes.delete('/availability/:id', deleteMyAvailability);
portalRoutes.get('/appointments', listMyAppointments);
portalRoutes.patch('/appointments/:id/status', updateMyAppointmentStatus);
portalRoutes.get('/exceptions', listMyExceptions);
portalRoutes.post('/exceptions', createException);
portalRoutes.delete('/exceptions/:id', deleteException);

export const doctorRoutes = Router();

doctorRoutes.get('/', listDoctors);
doctorRoutes.post('/', authenticate, applyAsDoctor);
doctorRoutes.use('/me', portalRoutes);
doctorRoutes.get('/:id/availability', getDoctorAvailability);
doctorRoutes.get('/:id', getDoctor);
