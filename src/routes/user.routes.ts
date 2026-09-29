import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { getMe } from '../controllers/user.controller.js';

export const userRoutes = Router();

userRoutes.get('/', authenticate, getMe);
