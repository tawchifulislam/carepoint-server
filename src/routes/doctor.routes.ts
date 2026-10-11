import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { requireApproved, requireRole } from '../middlewares/authorize.js';
import {
  applyAsDoctor,
  getDoctor,
  getDoctorAvailability,
  listDoctors,
} from '../controllers/doctor.controller.js';
import { listDoctorAppointments } from '../controllers/doctor-appointments.controller.js';
import {
  createAvailabilityRule,
  createException,
  deleteException,
  deleteMyAvailability,
  listMyAvailability,
  listMyExceptions,
  updateMyAppointmentStatus,
} from '../controllers/doctor-portal.controller.js';

const portalRoutes = Router();

portalRoutes.use(authenticate, requireRole('DOCTOR'), requireApproved);
portalRoutes.get('/availability', listMyAvailability);
portalRoutes.post('/availability', createAvailabilityRule);
portalRoutes.delete('/availability/:id', deleteMyAvailability);
portalRoutes.get('/appointments', listDoctorAppointments);
portalRoutes.patch('/appointments/:id/status', updateMyAppointmentStatus);
portalRoutes.get('/exceptions', listMyExceptions);
portalRoutes.post('/exceptions', createException);
portalRoutes.delete('/exceptions/:id', deleteException);

export const doctorRoutes = Router();

doctorRoutes.get('/', listDoctors);
doctorRoutes.post('/', authenticate, requireRole('PATIENT'), applyAsDoctor);
doctorRoutes.use('/me', portalRoutes);
doctorRoutes.get('/:id/availability', getDoctorAvailability);
doctorRoutes.get('/:id', getDoctor);
