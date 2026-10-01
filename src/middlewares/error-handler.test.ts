import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('error handling', () => {
  it('returns JSON for an unknown route', async () => {
    const response = await request(app).get('/api/this-route-does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
  });

  it('returns JSON for a malformed request body', async () => {
    const response = await request(app)
      .post('/api/clinics')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json');

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
