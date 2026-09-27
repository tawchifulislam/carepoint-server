import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './authenticate.js';

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function requireApproved(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const status =
    req.user?.doctorApprovalStatus ?? req.user?.clinicApprovalStatus;

  if (status && status !== 'APPROVED') {
    res.status(403).json({ error: 'Account pending approval' });
    return;
  }

  next();
}
