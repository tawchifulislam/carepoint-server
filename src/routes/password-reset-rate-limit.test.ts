import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

const CLIENT = process.env.CLIENT_URL ?? 'http://localhost:3000';

describe('password reset rate limit', () => {
  it('stops after five requests from the same address', async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await request(app)
        .post('/api/auth/request-password-reset')
        .send({
          email: `limit-${Date.now()}-${attempt}@test.com`,
          redirectTo: `${CLIENT}/reset-password`,
        });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5).every(status => status === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
