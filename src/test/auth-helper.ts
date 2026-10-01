import type { NextFunction, Request, Response } from 'express';

export interface TestUser {
  id: string;
  role: string;
  doctorApprovalStatus?: string;
  clinicApprovalStatus?: string;
}

let currentUser: TestUser | null = null;

export function setTestUser(user: TestUser | null): void {
  currentUser = user;
}

export function fakeAuthenticate(
  req: Request & { user?: TestUser },
  res: Response,
  next: NextFunction,
): void {
  if (!currentUser) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  req.user = currentUser;
  next();
}
