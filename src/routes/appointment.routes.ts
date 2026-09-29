import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  cancelAppointment,
  createAppointment,
  getAppointment,
  getMyAppointments,
  rescheduleAppointment,
} from '../controllers/appointment.controller.js';

export const appointmentRoutes = Router();

appointmentRoutes.post('/', authenticate, createAppointment);
appointmentRoutes.get('/me', authenticate, getMyAppointments);
appointmentRoutes.get('/:id', authenticate, getAppointment);
appointmentRoutes.patch('/:id/cancel', authenticate, cancelAppointment);
appointmentRoutes.patch('/:id/reschedule', authenticate, rescheduleAppointment);
