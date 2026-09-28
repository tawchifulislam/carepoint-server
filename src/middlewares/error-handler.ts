import type { NextFunction, Request, Response } from 'express';

function getStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;

    if (typeof status === 'number' && status >= 400 && status < 600) {
      return status;
    }
  }

  return 500;
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const status = getStatus(error);

  if (status >= 500) {
    console.error(error);
  }

  res
    .status(status)
    .json({ error: status >= 500 ? 'Internal server error' : 'Bad request' });
}
