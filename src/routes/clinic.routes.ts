import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { applyAsClinicAdmin } from '../controllers/clinic.controller.js';

export const clinicRoutes = Router();

clinicRoutes.post('/', authenticate, applyAsClinicAdmin);
