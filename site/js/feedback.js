/** Landing feedback modal (#315 / site follow-up). */

export const MAX_MESSAGE_LENGTH = 2000;
export const MESSAGE_COUNTER_FROM = 1800;
export const COUNTER_ARIA_LIVE_THROTTLE_MS = 400;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

function isExcludedFromFocusTrap(el) {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  if (el.closest('[hidden], [inert]')) {
    return true;
  }
  return false;
}

export function getFocusableElements(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => !isExcludedFromFocusTrap(el));
}

export const FEEDBACK_UI_TEMPLATE_ID = 'feedback-ui-template';

/** Mount shared form + success markup from `#feedback-ui-template` into the modal shell. */
export function mountFeedbackUi(documentRoot) {
  const template =
    documentRoot.querySelector?.(`#${FEEDBACK_UI_TEMPLATE_ID}`) ??
    documentRoot.getElementById?.(FEEDBACK_UI_TEMPLATE_ID);
  if (!template) return;

  const dialogMount = documentRoot.querySelector('[data-feedback-dialog] [data-feedback-mount]');
  if (dialogMount && !dialogMount.querySelector('[data-feedback-form]')) {
    dialogMount.appendChild(template.content.cloneNode(true));
  }
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
  const submitBtn = form.querySelector('[data-feedback-submit]');
  const description = form.description?.value ?? '';
  const hasText = description.trim().length > 0;
  const sending = form.dataset.state === 'sending';
  if (submitBtn) {
    submitBtn.disabled = !hasText || sending;
  }
}

function updateMessageCounter(form, counterState) {
  const counter = form.querySelector('[data-feedback-counter]');
  const description = form.description?.value ?? '';
  if (!counter) return;
  if (description.length >= MESSAGE_COUNTER_FROM) {
    const text = formatMessageCounter(description.length);
    counter.textContent = text;
    counter.hidden = false;
    const now = Date.now();
    if (now - counterState.lastLiveAt >= COUNTER_ARIA_LIVE_THROTTLE_MS) {
      counter.setAttribute('aria-live', 'polite');
      counterState.lastLiveAt = now;
      clearTimeout(counterState.liveResetId);
      counterState.liveResetId = setTimeout(() => {
        counter.setAttribute('aria-live', 'off');
        counterState.lastLiveAt = 0;
      }, COUNTER_ARIA_LIVE_THROTTLE_MS);
    }
  } else {
    counter.textContent = '';
    counter.hidden = true;
    counter.setAttribute('aria-live', 'off');
    counterState.lastLiveAt = 0;
  }
}

function setFormState(form, state) {
  form.dataset.state = state;
  const sending = state === 'sending';
  form.querySelectorAll('input, textarea').forEach((node) => {
    if (node.name === 'website') return;
    node.readOnly = sending;
  });
  const submitBtn = form.querySelector('[data-feedback-submit]');
  const spinner = form.querySelector('[data-feedback-spinner]');
  const label = form.querySelector('.feedback-submit__label');
  if (submitBtn) {
    submitBtn.setAttribute('aria-busy', sending ? 'true' : 'false');
  }
  if (spinner) {
    spinner.hidden = !sending;
  }
  if (label) {
    label.textContent = sending ? 'Sending…' : 'Send feedback';
  }
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

function resetFeedbackForm(form, counterState) {
  form.reset();
  hideFormAlert(form);
  setFieldError(form, 'description', '');
  setFieldError(form, 'replyEmail', '');
  setFormState(form, 'idle');
  updateMessageCounter(form, counterState);
  setSubmitEnabled(form);
}

function showFormPanel(dialog) {
  const formPanel = dialog.querySelector('[data-feedback-form-panel]');
  const successPanel = dialog.querySelector('[data-feedback-success-panel]');
  if (formPanel) formPanel.hidden = false;
  if (successPanel) successPanel.hidden = true;
}

function showSuccessPanel(dialog) {
  const formPanel = dialog.querySelector('[data-feedback-form-panel]');
  const successPanel = dialog.querySelector('[data-feedback-success-panel]');
  if (formPanel) formPanel.hidden = true;
  if (successPanel) {
    successPanel.hidden = false;
    const status = successPanel.querySelector('[data-feedback-success-status]');
    status?.focus();
  }
}

function wireFocusTrap(dialog, onEscape) {
  const card = dialog.querySelector('.feedback-dialog__card');
  if (!card) return () => {};

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = getFocusableElements(card);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  dialog.addEventListener('keydown', onKeyDown);
  return () => dialog.removeEventListener('keydown', onKeyDown);
}

function wireFeedbackForm(form, dialog, siteVersion, counterState, closeModal) {
  if (!form) return;

  const installId = parseInstallId(window.localStorage);

  form.description?.addEventListener('input', () => {
    updateMessageCounter(form, counterState);
    setSubmitEnabled(form);
    hideFormAlert(form);
  });

  form.querySelector('[data-feedback-cancel]')?.addEventListener('click', () => {
    closeModal();
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
      return;
    }

    setFormState(form, 'sending');

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
        setFormState(form, 'idle');
        showSuccessPanel(dialog);
        return;
      }
      setFormState(form, 'idle');
      showFormAlert(form, feedbackErrorMessage(res.status));
    } catch {
      setFormState(form, 'idle');
      showFormAlert(form, feedbackErrorMessage(0));
    }
  });

  updateMessageCounter(form, counterState);
  setSubmitEnabled(form);
}

export function initFeedback(documentRoot) {
  mountFeedbackUi(documentRoot);
  const dialog = documentRoot.querySelector('[data-feedback-dialog]');
  const form = dialog?.querySelector('[data-feedback-form]');
  if (!dialog || !form) return;

  const siteVersion = documentRoot.dataset.siteVersion || '0.1.1';
  const counterState = { lastLiveAt: 0, liveResetId: undefined };
  let focusReturn = null;
  let removeTrap = () => {};

  const closeModal = () => {
    if (!dialog.open) return;
    clearTimeout(counterState.liveResetId);
    removeTrap();
    dialog.close();
    showFormPanel(dialog);
    resetFeedbackForm(form, counterState);
    const target = focusReturn;
    focusReturn = null;
    target?.focus();
  };

  const openModal = (trigger) => {
    focusReturn = trigger instanceof HTMLElement ? trigger : null;
    showFormPanel(dialog);
    resetFeedbackForm(form, counterState);
    dialog.showModal();
    removeTrap = wireFocusTrap(dialog, closeModal);
    form.description?.focus();
  };

  documentRoot.querySelectorAll('[data-feedback-open]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      if (
        trigger instanceof HTMLAnchorElement &&
        trigger.getAttribute('href')?.replace(/^.*#/, '#') === '#feedback'
      ) {
        event.preventDefault();
      }
      openModal(trigger);
    });
  });

  if (typeof window !== 'undefined' && window.location.hash === '#feedback') {
    openModal(null);
  }

  dialog.querySelectorAll('[data-feedback-close], [data-feedback-close-panel]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal());
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      closeModal();
    }
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal();
  });

  dialog.querySelector('[data-feedback-send-another]')?.addEventListener('click', () => {
    showFormPanel(dialog);
    resetFeedbackForm(form, counterState);
    form.description?.focus();
  });

  wireFeedbackForm(form, dialog, siteVersion, counterState, closeModal);
}

/** Run init now, or wait for DOMContentLoaded if the document is still loading. */
export function scheduleFeedbackInit(
  documentRoot = typeof document !== 'undefined' ? document.body : null,
) {
  if (!documentRoot || typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initFeedback(documentRoot);
    });
    return;
  }
  initFeedback(documentRoot);
}

if (typeof document !== 'undefined') {
  scheduleFeedbackInit(document.body);
}
