import { isRateLimited, normalizeResendFrom, sendResend } from '../_lib/email.ts';
import {
  MAX_BODY_BYTES,
  buildFeedbackEmail,
  isHoneypotTripped,
  parseClientHeader,
  validateClientRequest,
  validateFeedbackBody,
} from '../_lib/feedback.ts';

interface Env {
  RESEND_API_KEY: string;
  SWARMDRAFT_FEEDBACK_TO: string;
  SWARMDRAFT_FEEDBACK_FROM: string;
}

const IP_LIMIT = { max: 5, windowSeconds: 600 };
const INSTALL_LIMIT = { max: 10, windowSeconds: 86400 };
const LANDING_IP_LIMIT = { max: 3, windowSeconds: 600 };

function feedbackUnavailable(): Response {
  return Response.json({ error: 'feedback_unavailable' }, { status: 503 });
}

function feedbackSendFailed(): Response {
  return Response.json({ error: 'feedback_send_failed' }, { status: 502 });
}

function resolveFeedbackEnv(env: Env): { apiKey: string; to: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.SWARMDRAFT_FEEDBACK_TO?.trim() ?? '';
  const from = normalizeResendFrom(env.SWARMDRAFT_FEEDBACK_FROM?.trim() ?? '');
  if (!apiKey || !to || !from) {
    return null;
  }
  return { apiKey, to, from };
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  const clientHeader = request.headers.get('X-SwarmDraft-Client');
  const client = parseClientHeader(clientHeader);
  const origin = request.headers.get('Origin');
  const clientCheck = validateClientRequest(client, origin);
  if (clientCheck === 'unknown_client') {
    return Response.json(
      {
        errors: {
          client: ['The X-SwarmDraft-Client header must be desktop/<semver> or landing/<semver>.'],
        },
      },
      { status: 422 },
    );
  }
  if (clientCheck === 'forbidden_origin') {
    return Response.json({ message: 'Origin not allowed.' }, { status: 403 });
  }

  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return Response.json({ message: 'Request body too large.' }, { status: 400 });
  }

  const rawText = await request.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return Response.json({ message: 'Request body too large.' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return Response.json({ message: 'Invalid JSON body.' }, { status: 400 });
  }

  if (isHoneypotTripped(body)) {
    return Response.json({ ok: true }, { status: 202 });
  }

  const { errors, payload } = validateFeedbackBody(body);
  if (errors) {
    return Response.json({ errors }, { status: 422 });
  }
  if (!payload) {
    return Response.json({ message: 'Invalid feedback.' }, { status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (
    await isRateLimited({
      prefix: 'feedback-ip',
      identifier: ip,
      maxRequests: IP_LIMIT.max,
      windowSeconds: IP_LIMIT.windowSeconds,
    })
  ) {
    return Response.json({ message: 'Too many requests. Try again later.' }, { status: 429 });
  }

  if (payload.source === 'landing') {
    if (
      await isRateLimited({
        prefix: 'feedback-landing-ip',
        identifier: ip,
        maxRequests: LANDING_IP_LIMIT.max,
        windowSeconds: LANDING_IP_LIMIT.windowSeconds,
      })
    ) {
      return Response.json({ message: 'Too many requests. Try again later.' }, { status: 429 });
    }
  }

  if (
    await isRateLimited({
      prefix: 'feedback-install',
      identifier: payload.installId,
      maxRequests: INSTALL_LIMIT.max,
      windowSeconds: INSTALL_LIMIT.windowSeconds,
    })
  ) {
    return Response.json({ message: 'Too many requests. Try again later.' }, { status: 429 });
  }

  const mailEnv = resolveFeedbackEnv(env);
  if (!mailEnv) {
    return feedbackUnavailable();
  }

  const email = buildFeedbackEmail(payload);
  const idempotencyKey = `${payload.installId}:${payload.nonce}`;

  try {
    const res = await sendResend(
      mailEnv.apiKey,
      {
        from: mailEnv.from,
        to: [mailEnv.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        reply_to: payload.replyEmail,
        attachments: email.attachments,
      },
      idempotencyKey,
    );

    if (!res.ok) {
      return feedbackSendFailed();
    }
  } catch {
    return feedbackSendFailed();
  }

  return Response.json({ ok: true }, { status: 202 });
}
