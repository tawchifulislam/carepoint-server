import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setTestUser } from '../test/auth-helper.js';

vi.mock('../middlewares/authenticate.js', async () => {
  const { fakeAuthenticate } = await import('../test/auth-helper.js');
  return { authenticate: fakeAuthenticate };
});

describe('GET /api/me', () => {
  it("returns the current user's profile", async () => {
    const user = await prisma.user.create({
      data: { name: 'Me User', email: `me-${Date.now()}@test.com` },
    });
    setTestUser({ id: user.id, role: 'PATIENT' });

    const response = await request(app).get('/api/me');

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(user.id);
    expect(response.body.email).toBe(user.email);
  });

  it('rejects an unauthenticated request', async () => {
    setTestUser(null);

    const response = await request(app).get('/api/me');

    expect(response.status).toBe(401);
  });
});
