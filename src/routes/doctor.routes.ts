import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { applyAsDoctor } from '../controllers/doctor.controller.js';

export const doctorRoutes = Router();

doctorRoutes.post('/', authenticate, applyAsDoctor);
