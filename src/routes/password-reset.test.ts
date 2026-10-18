import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { resend } from '../lib/resend.js';

const CLIENT = process.env.CLIENT_URL ?? 'http://localhost:3000';
const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('password reset', () => {
  let email = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    email = `reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;

    const signUp = await request(app)
      .post('/api/auth/sign-up/email')
      .send({ name: 'Reset User', email, password: OLD_PASSWORD });

    expect(signUp.status).toBe(200);
  });

  function lastEmail() {
    const calls = vi.mocked(resend.emails.send).mock.calls;
    return calls[calls.length - 1]?.[0] as
      | { to: string; html: string }
      | undefined;
  }

  function tokenFrom(html: string): string {
    return html.match(/reset-password\/([^?"&<\s]+)/)?.[1] ?? '';
  }

  it('emails a reset link to a registered address', async () => {
    const response = await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: `${CLIENT}/reset-password` });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(resend.emails.send).toHaveBeenCalledTimes(1));
    expect(lastEmail()?.to).toBe(email);
    expect(tokenFrom(lastEmail()?.html ?? '')).not.toBe('');
  });

  it('answers the same way for an unknown address and sends nothing', async () => {
    const response = await request(app)
      .post('/api/auth/request-password-reset')
      .send({
        email: `nobody-${Date.now()}@test.com`,
        redirectTo: `${CLIENT}/reset-password`,
      });

    await wait(400);

    expect(response.status).toBe(200);
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it('lets the new password in, shuts the old one out, and works only once', async () => {
    await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: `${CLIENT}/reset-password` });
    await vi.waitFor(() => expect(resend.emails.send).toHaveBeenCalledTimes(1));

    const token = tokenFrom(lastEmail()?.html ?? '');
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token });

    expect(reset.status).toBe(200);

    const withNew = await request(app)
      .post('/api/auth/sign-in/email')
      .send({ email, password: NEW_PASSWORD });
    const withOld = await request(app)
      .post('/api/auth/sign-in/email')
      .send({ email, password: OLD_PASSWORD });
    const reused = await request(app)
      .post('/api/auth/reset-password')
      .send({ newPassword: 'another-pass-789', token });

    expect(withNew.status).toBe(200);
    expect(withOld.status).toBeGreaterThanOrEqual(400);
    expect(reused.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to build a link that redirects to another site', async () => {
    const response = await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email, redirectTo: 'https://evil.example.com/reset-password' });

    await wait(400);

    expect(response.status).toBe(403);
    expect(resend.emails.send).not.toHaveBeenCalled();
  });
});
