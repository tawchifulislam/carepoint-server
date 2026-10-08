import { Router } from 'express';
import { getPublicStats } from '../controllers/stats.controller.js';

export const statsRoutes = Router();

statsRoutes.get('/', getPublicStats);
