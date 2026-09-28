import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';

const authUrl = process.env.BETTER_AUTH_URL;

if (!authUrl) {
  throw new Error('BETTER_AUTH_URL is not set');
}

const JWKS = createRemoteJWKSet(new URL('/api/auth/jwks', authUrl));

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: string;
    doctorApprovalStatus?: string;
    clinicApprovalStatus?: string;
  };
}

export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: authUrl,
      audience: authUrl,
    });

    if (!payload.sub) {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { doctor: true, adminOfClinic: true },
    });

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = {
      id: user.id,
      role: user.role,
      doctorApprovalStatus: user.doctor?.approvalStatus,
      clinicApprovalStatus: user.adminOfClinic?.approvalStatus,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
