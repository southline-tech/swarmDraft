/** Landing feedback form (#315). */

export const FEEDBACK_CONTACT_EMAIL = 'radiancelux@gmail.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFeedbackForm(description, replyEmail) {
  const errors = {};
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) {
    errors.description = 'Please describe your feedback.';
  } else if (text.length > 4000) {
    errors.description = 'Feedback must be 4000 characters or fewer.';
  }
  const email = typeof replyEmail === 'string' ? replyEmail.trim() : '';
  if (email && !EMAIL_RE.test(email)) {
    errors.replyEmail = 'Enter a valid email address or leave this blank.';
  }
  return errors;
}

export function feedbackErrorMessage(status) {
  if (status === 429) {
    return 'Too many messages recently. Wait a few minutes, then try again.';
  }
  if (status === 502 || status === 503) {
    return 'Feedback is temporarily unavailable. Try again later or email us directly.';
  }
  return "Couldn't send feedback. Check your connection and try again.";
}

export function parseInstallId(storage) {
  const key = 'swarmdraft-feedback-install-id';
  let id = storage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(key, id);
  }
  return id;
}

export function buildLandingPayload({ description, replyEmail, installId, siteVersion }) {
  const payload = {
    area: 'other',
    type: 'idea',
    description: description.trim(),
    appVersion: siteVersion,
    os: 'Web',
    installId,
    nonce: crypto.randomUUID(),
    source: 'landing',
    website: '',
  };
  const email = (replyEmail || '').trim();
  if (email) {
    payload.replyEmail = email;
  }
  return payload;
}

function setFieldError(form, name, message) {
  const el = form.querySelector(`[data-feedback-error="${name}"]`);
  const input = form.querySelector(`[name="${name}"]`);
  if (!el || !input) return;
  if (message) {
    el.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', el.id);
  } else {
    el.textContent = '';
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}

function setFormState(form, state) {
  form.dataset.state = state;
  const sending = state === 'sending';
  const success = state === 'success';
  form.querySelectorAll('input, textarea, button').forEach((node) => {
    if (node.name === 'website') return;
    node.disabled = sending || success;
  });
}

export function initFeedbackForm(root) {
  const form = root.querySelector('[data-feedback-form]');
  if (!form) return;

  const siteVersion = root.dataset.siteVersion || '0.1.1';
  const statusEl = form.querySelector('[data-feedback-status]');
  const installId = parseInstallId(window.localStorage);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = form.description.value;
    const replyEmail = form.replyEmail?.value ?? '';
    const errors = validateFeedbackForm(description, replyEmail);

    setFieldError(form, 'description', errors.description);
    setFieldError(form, 'replyEmail', errors.replyEmail);
    if (Object.keys(errors).length) {
      if (statusEl) {
        statusEl.textContent = 'Fix the highlighted fields, then try again.';
      }
      const first = form.querySelector('[aria-invalid="true"]');
      first?.focus();
      return;
    }

    setFormState(form, 'sending');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn?.setAttribute('aria-busy', 'true');
    if (statusEl) statusEl.textContent = 'Sending…';

    const payload = buildLandingPayload({
      description,
      replyEmail,
      installId,
      siteVersion,
    });

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SwarmDraft-Client': `landing/${siteVersion}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.status === 202) {
        setFormState(form, 'success');
        submitBtn?.removeAttribute('aria-busy');
        if (statusEl) {
          statusEl.textContent = 'Thanks — we received your feedback.';
        }
        form.reset();
        return;
      }
      setFormState(form, 'idle');
      submitBtn?.removeAttribute('aria-busy');
      if (statusEl) {
        statusEl.textContent = feedbackErrorMessage(res.status);
      }
    } catch {
      setFormState(form, 'idle');
      submitBtn?.removeAttribute('aria-busy');
      if (statusEl) {
        statusEl.textContent = feedbackErrorMessage(0);
      }
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initFeedbackForm(document.body);
  });
}
