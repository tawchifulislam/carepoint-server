import { z } from 'zod';

export const approvalDecisionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});
