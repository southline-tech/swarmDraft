const AREAS = new Set(['editor', 'review', 'export', 'agents', 'install', 'other']);
const TYPES = new Set(['bug', 'idea', 'question']);
const SOURCES = new Set(['app', 'bot', 'landing']);

const ALLOWED_KEYS = new Set([
  'area',
  'type',
  'description',
  'appVersion',
  'os',
  'installId',
  'nonce',
  'source',
  'botName',
  'replyEmail',
  'includeText',
  'excerpt',
  'screenshotPng',
  'website',
  'diagnostics',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DESKTOP_CLIENT_RE = /^desktop\/(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;
const LANDING_CLIENT_RE = /^landing\/(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.swarmdraft\.pages\.dev$/;

const ALLOWED_ORIGINS = new Set([
  'https://swarmdraft.ai',
  'https://www.swarmdraft.ai',
  'https://swarmdraft.pages.dev',
]);

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_EXCERPT = 2000;
export const MAX_DESCRIPTION = 4000;
export const MAX_LANDING_DESCRIPTION = 2000;
export const MAX_SCREENSHOT_BYTES = Math.floor(1.5 * 1024 * 1024);

export type ClientKind = 'desktop' | 'landing';

export type FeedbackPayload = {
  area: string;
  type: string;
  description: string;
  appVersion: string;
  os: string;
  installId: string;
  nonce: string;
  source: string;
  botName?: string;
  replyEmail?: string;
  includeText: boolean;
  excerpt?: string;
  screenshotPng?: string;
  recentErrors?: string[];
};

export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- strip C0 controls from user text
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseClientHeader(
  header: string | null,
): { kind: ClientKind; version: string } | null {
  if (!header) return null;
  const trimmed = header.trim();
  const desktop = DESKTOP_CLIENT_RE.exec(trimmed);
  if (desktop) {
    return { kind: 'desktop', version: desktop[1] };
  }
  const landing = LANDING_CLIENT_RE.exec(trimmed);
  if (landing) {
    return { kind: 'landing', version: landing[1] };
  }
  return null;
}

export function isAllowedFeedbackOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return PREVIEW_ORIGIN_RE.test(origin);
}

export function validateClientRequest(
  client: { kind: ClientKind; version: string } | null,
  origin: string | null,
): 'ok' | 'unknown_client' | 'forbidden_origin' {
  if (!client) {
    return 'unknown_client';
  }
  if (client.kind === 'desktop') {
    if (origin) {
      return 'forbidden_origin';
    }
    return 'ok';
  }
  if (!isAllowedFeedbackOrigin(origin)) {
    return 'forbidden_origin';
  }
  return 'ok';
}

export function validateSourceMatchesClient(
  client: { kind: ClientKind },
  source: string,
): Record<string, string[]> | null {
  if (client.kind === 'landing' && source !== 'landing') {
    return { source: ['Landing client must use source landing.'] };
  }
  if (client.kind === 'desktop' && source === 'landing') {
    return { source: ['Desktop client cannot use source landing.'] };
  }
  return null;
}

export function isHoneypotTripped(raw: Record<string, unknown>): boolean {
  const website = raw.website;
  if (typeof website !== 'string') {
    return false;
  }
  return website.trim().length > 0;
}

export function validateFeedbackBody(raw: Record<string, unknown>): {
  errors: Record<string, string[]> | null;
  payload: FeedbackPayload | null;
} {
  const errors: Record<string, string[]> = {};

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors._unknown = [`Unknown field "${key}".`];
    }
  }
  if (errors._unknown) {
    return { errors, payload: null };
  }

  const area = typeof raw.area === 'string' ? raw.area.trim() : '';
  if (!AREAS.has(area)) {
    errors.area = ['The area must be one of: editor, review, export, agents, install, other.'];
  }

  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!TYPES.has(type)) {
    errors.type = ['The type must be one of: bug, idea, question.'];
  }

  const sourceHint = typeof raw.source === 'string' ? raw.source.trim() : '';
  const maxDescription = sourceHint === 'landing' ? MAX_LANDING_DESCRIPTION : MAX_DESCRIPTION;

  const description = typeof raw.description === 'string' ? stripControlChars(raw.description) : '';
  if (!description.trim()) {
    errors.description = ['The description field is required.'];
  } else if (description.length > maxDescription) {
    errors.description = [`The description may not be greater than ${maxDescription} characters.`];
  }

  const appVersion = typeof raw.appVersion === 'string' ? raw.appVersion.trim() : '';
  if (!SEMVER_RE.test(appVersion)) {
    errors.appVersion = ['The appVersion must be a valid semver.'];
  }

  const os = typeof raw.os === 'string' ? stripControlChars(raw.os).trim() : '';
  if (!os) {
    errors.os = ['The os field is required.'];
  } else if (os.length > 512) {
    errors.os = ['The os may not be greater than 512 characters.'];
  }

  const installId = typeof raw.installId === 'string' ? raw.installId.trim() : '';
  if (!UUID_RE.test(installId)) {
    errors.installId = ['The installId must be a valid UUID.'];
  }

  const nonce = typeof raw.nonce === 'string' ? raw.nonce.trim() : '';
  if (!nonce) {
    errors.nonce = ['The nonce field is required.'];
  } else if (nonce.length > 128) {
    errors.nonce = ['The nonce may not be greater than 128 characters.'];
  }

  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (!SOURCES.has(source)) {
    errors.source = ['The source must be app, bot, or landing.'];
  }

  let botName: string | undefined;
  if (raw.botName !== undefined && raw.botName !== null) {
    if (typeof raw.botName !== 'string') {
      errors.botName = ['The botName must be a string.'];
    } else {
      botName = stripControlChars(raw.botName).trim();
      if (botName.length > 255) {
        errors.botName = ['The botName may not be greater than 255 characters.'];
      }
    }
  }

  if (source === 'bot' && !botName) {
    errors.botName = ['The botName field is required when source is bot.'];
  }

  let replyEmail: string | undefined;
  if (raw.replyEmail !== undefined && raw.replyEmail !== null && raw.replyEmail !== '') {
    if (typeof raw.replyEmail !== 'string') {
      errors.replyEmail = ['The replyEmail must be a string.'];
    } else {
      replyEmail = raw.replyEmail.trim();
      if (!EMAIL_RE.test(replyEmail)) {
        errors.replyEmail = ['The replyEmail must be a valid email address.'];
      }
    }
  }

  const includeText = raw.includeText === true;

  let excerpt: string | undefined;
  if (includeText && raw.excerpt !== undefined && raw.excerpt !== null) {
    if (typeof raw.excerpt !== 'string') {
      errors.excerpt = ['The excerpt must be a string.'];
    } else {
      excerpt = stripControlChars(raw.excerpt);
      if (excerpt.length > MAX_EXCERPT) {
        errors.excerpt = [`The excerpt may not be greater than ${MAX_EXCERPT} characters.`];
      }
    }
  }

  let screenshotPng: string | undefined;
  if (raw.screenshotPng !== undefined && raw.screenshotPng !== null && raw.screenshotPng !== '') {
    if (typeof raw.screenshotPng !== 'string') {
      errors.screenshotPng = ['The screenshotPng must be a base64 string.'];
    } else {
      screenshotPng = raw.screenshotPng.trim();
      try {
        const bytes = atob(screenshotPng);
        if (bytes.length > MAX_SCREENSHOT_BYTES) {
          errors.screenshotPng = ['The screenshot may not be greater than 1.5 MB.'];
        }
      } catch {
        errors.screenshotPng = ['The screenshotPng must be valid base64.'];
      }
    }
  }

  let recentErrors: string[] | undefined;
  if (raw.diagnostics !== undefined && raw.diagnostics !== null) {
    if (source === 'landing') {
      errors.diagnostics = ['Landing feedback cannot include diagnostics.'];
    } else if (typeof raw.diagnostics !== 'object' || Array.isArray(raw.diagnostics)) {
      errors.diagnostics = ['The diagnostics must be an object.'];
    } else {
      const diag = raw.diagnostics as Record<string, unknown>;
      const lines = diag.recentErrors;
      if (lines !== undefined && lines !== null) {
        if (!Array.isArray(lines)) {
          errors.diagnostics = ['diagnostics.recentErrors must be an array.'];
        } else if (lines.length > 8) {
          errors.diagnostics = ['diagnostics.recentErrors may not exceed 8 entries.'];
        } else {
          recentErrors = [];
          for (const line of lines) {
            if (typeof line !== 'string') {
              errors.diagnostics = ['Each recent error must be a string.'];
              break;
            }
            const cleaned = stripControlChars(line).trim();
            if (cleaned.length > 512) {
              errors.diagnostics = ['Each recent error may not exceed 512 characters.'];
              break;
            }
            if (cleaned) {
              recentErrors.push(cleaned);
            }
          }
        }
      }
    }
  }

  if (source === 'landing') {
    if (includeText) {
      errors.includeText = ['Landing feedback cannot include manuscript text.'];
    }
    if (raw.excerpt !== undefined && raw.excerpt !== null && raw.excerpt !== '') {
      errors.excerpt = ['Landing feedback cannot include an excerpt.'];
    }
    if (raw.screenshotPng !== undefined && raw.screenshotPng !== null && raw.screenshotPng !== '') {
      errors.screenshotPng = ['Landing feedback cannot include a screenshot.'];
    }
  }

  if (Object.keys(errors).length) {
    return { errors, payload: null };
  }

  return {
    errors: null,
    payload: {
      area,
      type,
      description: description.trim(),
      appVersion,
      os,
      installId,
      nonce,
      source,
      botName,
      replyEmail,
      includeText,
      excerpt: includeText ? excerpt : undefined,
      screenshotPng,
      recentErrors: recentErrors?.length ? recentErrors : undefined,
    },
  };
}

export function buildFeedbackEmail(payload: FeedbackPayload): {
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: string }>;
} {
  const subject = `[swarmDraft feedback] ${payload.type}/${payload.area} v${payload.appVersion} (${payload.source})`;

  const lines = [
    `Area: ${payload.area}`,
    `Type: ${payload.type}`,
    `Source: ${payload.source}`,
    `App version: ${payload.appVersion}`,
    `OS: ${payload.os}`,
    `Install ID: ${payload.installId}`,
  ];
  if (payload.botName) {
    lines.push(`Bot: ${payload.botName}`);
  }
  if (payload.replyEmail) {
    lines.push(`Reply-To: ${payload.replyEmail}`);
  }
  lines.push('', 'Description:', payload.description);
  if (payload.includeText && payload.excerpt) {
    lines.push('', 'Excerpt:', payload.excerpt);
  }
  if (payload.recentErrors?.length) {
    lines.push('', 'Recent errors:', ...payload.recentErrors);
  }

  const text = lines.join('\n');

  const htmlParts = [
    `<p><strong>Area:</strong> ${escapeHtml(payload.area)}</p>`,
    `<p><strong>Type:</strong> ${escapeHtml(payload.type)}</p>`,
    `<p><strong>Source:</strong> ${escapeHtml(payload.source)}</p>`,
    `<p><strong>App version:</strong> ${escapeHtml(payload.appVersion)}</p>`,
    `<p><strong>OS:</strong> ${escapeHtml(payload.os)}</p>`,
    `<p><strong>Install ID:</strong> ${escapeHtml(payload.installId)}</p>`,
  ];
  if (payload.botName) {
    htmlParts.push(`<p><strong>Bot:</strong> ${escapeHtml(payload.botName)}</p>`);
  }
  htmlParts.push(
    `<p><strong>Description:</strong></p><pre>${escapeHtml(payload.description)}</pre>`,
  );
  if (payload.includeText && payload.excerpt) {
    htmlParts.push(`<p><strong>Excerpt:</strong></p><pre>${escapeHtml(payload.excerpt)}</pre>`);
  }
  if (payload.recentErrors?.length) {
    htmlParts.push(
      `<p><strong>Recent errors:</strong></p><pre>${escapeHtml(payload.recentErrors.join('\n'))}</pre>`,
    );
  }

  const result: {
    subject: string;
    text: string;
    html: string;
    attachments?: Array<{ filename: string; content: string }>;
  } = {
    subject,
    text,
    html: htmlParts.join('\n'),
  };

  if (payload.screenshotPng) {
    result.attachments = [{ filename: 'screenshot.png', content: payload.screenshotPng }];
  }

  return result;
}
