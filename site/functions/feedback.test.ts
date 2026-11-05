import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost } from './api/feedback.ts';
import { isAllowedFeedbackOrigin, validateFeedbackBody } from './_lib/feedback.ts';

const installId = '550e8400-e29b-41d4-a716-446655440000';

const env = {
  RESEND_API_KEY: 're_test_key_abc',
  SWARMDRAFT_FEEDBACK_TO: 'feedback@example.com',
  SWARMDRAFT_FEEDBACK_FROM: 'swarmDraft <contact@example.com>',
};

const validDesktopBody = {
  area: 'editor',
  type: 'bug',
  description: 'Crash on save',
  appVersion: '0.1.0',
  os: 'Windows 11',
  installId,
  nonce: 'nonce-42',
  source: 'app',
};

const validLandingBody = {
  area: 'other',
  type: 'idea',
  description: 'Nice landing page',
  appVersion: '0.1.1',
  os: 'Web',
  installId,
  nonce: 'nonce-landing',
  source: 'landing',
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
  client = 'desktop/0.1.0',
): Request {
  return new Request('https://swarmdraft.ai/api/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SwarmDraft-Client': client,
      'CF-Connecting-IP': '203.0.113.10',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function mockCache(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  const cache = {
    match: vi.fn(async (key: Request) => {
      const count = store.get(key.url);
      return count === undefined ? undefined : new Response(String(count));
    }),
    put: vi.fn(async (key: Request, res: Response) => {
      store.set(key.url, Number(await res.text()));
    }),
  };
  vi.stubGlobal('caches', { default: cache });
  return cache;
}

describe('feedback API onRequestPost', () => {
  beforeEach(() => {
    mockCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 503 when env is incomplete', async () => {
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody),
      env: { ...env, RESEND_API_KEY: '' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feedback_unavailable' });
  });

  it('returns 502 when Resend fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody),
      env,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'feedback_send_failed' });
  });

  it('returns 422 for unknown client header', async () => {
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody, {}, 'mobile/1.0.0'),
      env,
    });
    expect(res.status).toBe(422);
  });

  it('returns 403 when desktop request sends Origin', async () => {
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody, { Origin: 'https://swarmdraft.ai' }),
      env,
    });
    expect(res.status).toBe(403);
  });

  it('accepts desktop without Origin', async () => {
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody),
      env,
    });
    expect(res.status).toBe(202);
  });

  it('returns 403 for disallowed landing Origin', async () => {
    const res = await onRequestPost({
      request: makeRequest(validLandingBody, { Origin: 'https://evil.example' }, 'landing/0.1.1'),
      env,
    });
    expect(res.status).toBe(403);
  });

  it('accepts allowed landing Origin', async () => {
    const res = await onRequestPost({
      request: makeRequest(validLandingBody, { Origin: 'https://swarmdraft.ai' }, 'landing/0.1.1'),
      env,
    });
    expect(res.status).toBe(202);
  });

  it('accepts preview subdomain Origin', async () => {
    expect(isAllowedFeedbackOrigin('https://feat-315.swarmdraft.pages.dev')).toBe(true);
    const res = await onRequestPost({
      request: makeRequest(
        validLandingBody,
        { Origin: 'https://feat-315.swarmdraft.pages.dev' },
        'landing/0.1.1',
      ),
      env,
    });
    expect(res.status).toBe(202);
  });

  it('returns 202 for honeypot without calling Resend', async () => {
    const fetchMock = vi.mocked(fetch);
    const res = await onRequestPost({
      request: makeRequest({ ...validDesktopBody, website: 'http://spam.test' }),
      env,
    });
    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 422 when bot source lacks botName', async () => {
    const res = await onRequestPost({
      request: makeRequest({ ...validDesktopBody, source: 'bot' }),
      env,
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { errors: Record<string, string[]> };
    expect(json.errors.botName).toBeDefined();
  });

  it('returns 422 when landing includes excerpt or screenshot', async () => {
    for (const body of [
      { ...validLandingBody, includeText: true, excerpt: 'secret' },
      { ...validLandingBody, screenshotPng: btoa('x') },
    ]) {
      const res = await onRequestPost({
        request: makeRequest(body, { Origin: 'https://swarmdraft.ai' }, 'landing/0.1.1'),
        env,
      });
      expect(res.status).toBe(422);
    }
  });

  it('returns 429 when landing IP rate limit exceeded', async () => {
    mockCache({
      [`https://rate-limit.swarmdraft.internal/feedback-landing-ip/${encodeURIComponent('203.0.113.10')}`]: 3,
    });
    const res = await onRequestPost({
      request: makeRequest(validLandingBody, { Origin: 'https://swarmdraft.ai' }, 'landing/0.1.1'),
      env,
    });
    expect(res.status).toBe(429);
  });

  it('returns 202 and sends Resend payload with idempotency', async () => {
    const fetchMock = vi.mocked(fetch);
    const res = await onRequestPost({
      request: makeRequest(validDesktopBody),
      env,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key_abc');
    expect(headers['Idempotency-Key']).toBe(`${installId}:nonce-42`);

    const payload = JSON.parse(init.body as string);
    expect(payload.to).toEqual(['feedback@example.com']);
    expect(payload.subject).toContain('[swarmDraft feedback]');
  });

  it('never logs the API key', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const errorSpy = vi.spyOn(console, 'error');
    await onRequestPost({ request: makeRequest(validDesktopBody), env });
    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(env.RESEND_API_KEY);
    }
  });
});

describe('validateFeedbackBody', () => {
  it('rejects unknown fields', () => {
    const { errors } = validateFeedbackBody({ ...validDesktopBody, extra: true });
    expect(errors?._unknown).toBeDefined();
  });
});
