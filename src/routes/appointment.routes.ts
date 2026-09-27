import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import {
  createAppointment,
  getMyAppointments,
  cancelAppointment,
} from '../controllers/appointment.controller.js';

export const appointmentRoutes = Router();

appointmentRoutes.post('/', authenticate, createAppointment);
appointmentRoutes.get('/me', authenticate, getMyAppointments);
appointmentRoutes.patch('/:id/cancel', authenticate, cancelAppointment);
