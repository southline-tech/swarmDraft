/** Landing feedback form (#315). */

export const MAX_MESSAGE_LENGTH = 2000;
export const MESSAGE_COUNTER_FROM = 1800;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFeedbackForm(description, replyEmail) {
  const errors = {};
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) {
    errors.description = 'Please describe your feedback.';
  } else if (text.length > MAX_MESSAGE_LENGTH) {
    errors.description = `Feedback must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  }
  const email = typeof replyEmail === 'string' ? replyEmail.trim() : '';
  if (email && !EMAIL_RE.test(email)) {
    errors.replyEmail = "That email doesn't look right.";
  }
  return errors;
}

export function feedbackErrorMessage(status) {
  if (status === 429) {
    return 'Too many messages recently. Wait a few minutes, then try again.';
  }
  if (status === 502 || status === 503) {
    return 'Feedback is temporarily unavailable. Try again later.';
  }
  return "Couldn't send. Check your connection and try again.";
}

export function formatMessageCounter(length) {
  const remaining = MAX_MESSAGE_LENGTH - length;
  return `${remaining} character${remaining === 1 ? '' : 's'} left`;
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
    el.setAttribute('role', 'alert');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', el.id);
  } else {
    el.textContent = '';
    el.removeAttribute('role');
    input.removeAttribute('aria-invalid');
    if (name === 'replyEmail') {
      input.setAttribute('aria-describedby', 'feedback-email-hint');
    } else {
      input.removeAttribute('aria-describedby');
    }
  }
}

function setSubmitEnabled(form) {
  const submitBtn = form.querySelector('button[type="submit"]');
  const description = form.description?.value ?? '';
  const hasText = description.trim().length > 0;
  const sending = form.dataset.state === 'sending';
  if (submitBtn) {
    submitBtn.disabled = !hasText || sending;
  }
}

function updateMessageCounter(form) {
  const counter = form.querySelector('[data-feedback-counter]');
  const description = form.description?.value ?? '';
  if (!counter) return;
  if (description.length >= MESSAGE_COUNTER_FROM) {
    counter.textContent = formatMessageCounter(description.length);
    counter.hidden = false;
  } else {
    counter.textContent = '';
    counter.hidden = true;
  }
}

function setFormState(form, state) {
  form.dataset.state = state;
  const sending = state === 'sending';
  form.querySelectorAll('input, textarea').forEach((node) => {
    if (node.name === 'website') return;
    if (sending) {
      node.readOnly = true;
    } else {
      node.readOnly = false;
    }
  });
  setSubmitEnabled(form);
}

function hideFormAlert(form) {
  const alertEl = form.querySelector('[data-feedback-alert]');
  if (!alertEl) return;
  alertEl.textContent = '';
  alertEl.hidden = true;
}

function showFormAlert(form, message) {
  const alertEl = form.querySelector('[data-feedback-alert]');
  if (!alertEl) return;
  alertEl.textContent = message;
  alertEl.hidden = false;
}

function buildSuccessView() {
  const wrap = document.createElement('div');
  wrap.className = 'feedback-success';
  wrap.setAttribute('role', 'status');
  wrap.innerHTML = `
    <p class="feedback-success__row">
      <svg class="feedback-success__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>
      </svg>
      <span>Thanks, your feedback is on its way.</span>
    </p>
    <button type="button" class="btn btn--text" data-feedback-send-another>Send another</button>
  `;
  return wrap;
}

function mountEmptyForm(root, siteVersion) {
  root.innerHTML = `
    <form
      class="feedback-form"
      data-feedback-form
      data-state="idle"
      novalidate
      aria-labelledby="feedback-title"
    >
      <div class="feedback-field">
        <label class="feedback-label" for="feedback-description">Your message</label>
        <textarea
          class="feedback-input feedback-input--area"
          id="feedback-description"
          name="description"
          rows="5"
          required
          autocomplete="off"
          maxlength="${MAX_MESSAGE_LENGTH}"
        ></textarea>
        <p class="feedback-counter" data-feedback-counter aria-live="polite" hidden></p>
        <p class="feedback-error" id="feedback-description-error" data-feedback-error="description"></p>
      </div>
      <div class="feedback-field">
        <label class="feedback-label" for="feedback-email">Email (optional)</label>
        <p class="feedback-hint" id="feedback-email-hint">Only if you'd like a reply.</p>
        <input
          class="feedback-input"
          type="email"
          id="feedback-email"
          name="replyEmail"
          autocomplete="email"
          inputmode="email"
          aria-describedby="feedback-email-hint"
        />
        <p class="feedback-error" id="feedback-reply-error" data-feedback-error="replyEmail"></p>
      </div>
      <div class="feedback-honeypot" aria-hidden="true">
        <label for="feedback-website">Website</label>
        <input type="text" id="feedback-website" name="website" tabindex="-1" autocomplete="off" />
      </div>
      <p class="feedback-alert" data-feedback-alert role="alert" hidden></p>
      <div class="feedback-actions">
        <button type="submit" class="btn btn--primary" disabled>Send feedback</button>
      </div>
    </form>
  `;
  wireFeedbackForm(root.querySelector('[data-feedback-form]'), root, siteVersion);
}

function showSuccessView(root, siteVersion) {
  const panel = document.createElement('div');
  panel.appendChild(buildSuccessView());
  root.replaceChildren(panel);
  const sendAnother = panel.querySelector('[data-feedback-send-another]');
  const statusRow = panel.querySelector('.feedback-success__row');
  if (statusRow instanceof HTMLElement) {
    statusRow.tabIndex = -1;
    statusRow.focus();
  }
  sendAnother?.addEventListener('click', () => {
    mountEmptyForm(root, siteVersion);
  });
}

function wireFeedbackForm(form, root, siteVersion) {
  if (!form) return;

  const installId = parseInstallId(window.localStorage);

  form.description?.addEventListener('input', () => {
    updateMessageCounter(form);
    setSubmitEnabled(form);
    hideFormAlert(form);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = form.description.value;
    const replyEmail = form.replyEmail?.value ?? '';
    const honeypot = form.website?.value ?? '';
    const errors = validateFeedbackForm(description, replyEmail);

    hideFormAlert(form);
    setFieldError(form, 'description', errors.description);
    setFieldError(form, 'replyEmail', errors.replyEmail);
    if (Object.keys(errors).length) {
      const first = form.querySelector('[aria-invalid="true"]');
      first?.focus();
      return;
    }

    if (honeypot.trim()) {
      showSuccessView(root, siteVersion);
      return;
    }

    setFormState(form, 'sending');
    const submitBtn = form.querySelector('button[type="submit"]');
    const defaultLabel = 'Send feedback';
    if (submitBtn) {
      submitBtn.textContent = 'Sending…';
      submitBtn.setAttribute('aria-busy', 'true');
    }

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
        showSuccessView(root, siteVersion);
        return;
      }
      setFormState(form, 'idle');
      if (submitBtn) {
        submitBtn.textContent = defaultLabel;
        submitBtn.removeAttribute('aria-busy');
      }
      showFormAlert(form, feedbackErrorMessage(res.status));
    } catch {
      setFormState(form, 'idle');
      if (submitBtn) {
        submitBtn.textContent = defaultLabel;
        submitBtn.removeAttribute('aria-busy');
      }
      showFormAlert(form, feedbackErrorMessage(0));
    }
  });

  updateMessageCounter(form);
  setSubmitEnabled(form);
}

export function initFeedbackForm(documentRoot) {
  const root = documentRoot.querySelector('[data-feedback-root]');
  const form = root?.querySelector('[data-feedback-form]');
  if (!root || !form) return;

  const siteVersion = documentRoot.dataset.siteVersion || '0.1.1';
  wireFeedbackForm(form, root, siteVersion);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initFeedbackForm(document.body);
  });
}
