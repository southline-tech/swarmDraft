const RATE_LIMIT_HOST = 'https://rate-limit.swarmdraft.internal';

export type RateLimitOptions = {
  /** Cache key namespace (e.g. feedback-ip). */
  prefix: string;
  identifier: string;
  maxRequests: number;
  windowSeconds: number;
};

/** Best-effort limit via Cache API (per-PoP, not global). */
export async function isRateLimited(options: RateLimitOptions): Promise<boolean> {
  const { prefix, identifier, maxRequests, windowSeconds } = options;
  const cache = caches.default;
  const key = new Request(
    `${RATE_LIMIT_HOST}/${encodeURIComponent(prefix)}/${encodeURIComponent(identifier)}`,
  );
  const existing = await cache.match(key);
  const count = existing ? Number(await existing.text()) || 0 : 0;
  if (count >= maxRequests) {
    return true;
  }
  await cache.put(key, new Response(String(count + 1)), {
    expirationTtl: windowSeconds,
  });
  return false;
}

/** Accept pasted dashboard values like `RESEND_FROM: Name <email@domain>`. */
export function normalizeResendFrom(raw: string): string {
  return raw
    .trim()
    .replace(/^RESEND_FROM\s*[:=]\s*/i, '')
    .trim();
}

export type ResendEmailPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: Array<{ filename: string; content: string }>;
};

export async function sendResend(
  apiKey: string,
  payload: ResendEmailPayload,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}
