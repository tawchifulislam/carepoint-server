import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function getPublicStats(_req: Request, res: Response) {
  const [appointmentsBooked, grouped] = await Promise.all([
    prisma.appointment.count({
      where: { status: { in: ['BOOKED', 'COMPLETED'] } },
    }),
    prisma.doctor.groupBy({
      by: ['specialty'],
      where: {
        approvalStatus: 'APPROVED',
        clinic: { approvalStatus: 'APPROVED' },
      },
      _count: { _all: true },
    }),
  ]);

  const specialties = grouped
    .map(row => ({ name: row.specialty, doctorCount: row._count._all }))
    .sort(
      (a, b) => b.doctorCount - a.doctorCount || a.name.localeCompare(b.name),
    );

  res.json({ appointmentsBooked, specialties });
}
