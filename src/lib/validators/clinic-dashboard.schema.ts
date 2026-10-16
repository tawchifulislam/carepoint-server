import { z } from 'zod';

export const dashboardQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
});

export type DashboardRange = z.infer<typeof dashboardQuerySchema>['range'];

export const RANGE_DAYS: Record<DashboardRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: 36_500,
};
