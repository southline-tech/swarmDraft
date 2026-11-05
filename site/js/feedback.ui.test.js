// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_UI_TEMPLATE_ID, initFeedback, mountFeedbackUi } from './feedback.js';

const FEEDBACK_UI_TEMPLATE = `
      <div data-feedback-form-panel>
        <h2 id="feedback-modal-title">Send feedback</h2>
        <form class="feedback-form" data-feedback-form data-state="idle" novalidate>
          <div class="feedback-field">
            <label class="feedback-label" for="feedback-description">Your message</label>
            <textarea
              class="feedback-input feedback-input--area"
              name="description"
              id="feedback-description"
              maxlength="2000"
            ></textarea>
            <p class="feedback-counter" data-feedback-counter aria-live="off" hidden></p>
            <p data-feedback-error="description" id="feedback-description-error"></p>
          </div>
          <div class="feedback-field">
            <label class="feedback-label" for="feedback-email">Email (optional)</label>
            <input
              class="feedback-input"
              type="email"
              name="replyEmail"
              id="feedback-email"
              aria-describedby="feedback-email-hint"
            />
            <p data-feedback-error="replyEmail" id="feedback-reply-error"></p>
          </div>
          <div class="feedback-honeypot" aria-hidden="true">
            <label for="feedback-website">Website</label>
            <input
              type="text"
              name="website"
              id="feedback-website"
              tabindex="-1"
              autocomplete="off"
              aria-hidden="true"
            />
          </div>
          <p data-feedback-alert role="alert" hidden></p>
          <div class="feedback-actions">
            <button type="button" class="btn btn--ghost" data-feedback-cancel>Cancel</button>
            <button type="submit" class="btn btn--primary" data-feedback-submit disabled>
              <span class="feedback-submit__label">Send feedback</span>
              <span data-feedback-spinner hidden></span>
            </button>
          </div>
        </form>
      </div>
      <div class="feedback-success" data-feedback-success-panel hidden>
        <p data-feedback-success-status tabindex="-1" role="status">Thanks</p>
        <button type="button" data-feedback-close-panel>Close</button>
        <button type="button" data-feedback-send-another>Send another</button>
      </div>
`;

function injectSiteCss() {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const file of ['tokens.css', 'main.css']) {
    const css = readFileSync(join(dir, '../css', file), 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
}

function buildFeedbackDom({ withCss = false } = {}) {
  if (withCss) {
    injectSiteCss();
  }
  document.body.dataset.siteVersion = '0.1.1';
  document.body.innerHTML = `
      <button type="button" data-feedback-open id="cta-open">Send feedback</button>
      <button type="button" data-feedback-open id="footer-open">Footer</button>
      <dialog class="feedback-dialog" data-feedback-dialog aria-labelledby="feedback-modal-title">
        <div class="feedback-dialog__card">
          <button type="button" data-feedback-close aria-label="Close">Close</button>
          <div data-feedback-mount></div>
        </div>
      </dialog>
      <template id="${FEEDBACK_UI_TEMPLATE_ID}">${FEEDBACK_UI_TEMPLATE}</template>
  `;
  mountFeedbackUi(document.body);
  return document.body;
}

describe('landing feedback modal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('opens the dialog, focuses the message field, and returns focus on close', () => {
    const root = buildFeedbackDom();
    initFeedback(root);
    const cta = root.querySelector('#cta-open');
    const dialog = root.querySelector('[data-feedback-dialog]');
    cta.focus();
    cta.click();
    expect(dialog.open).toBe(true);
    expect(document.activeElement?.id).toBe('feedback-description');
    root.querySelector('[data-feedback-close]').click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(cta);
  });

  it('shows validation errors without submitting', async () => {
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#cta-open').click();
    const form = root.querySelector('[data-feedback-form]');
    form.requestSubmit();
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('[data-feedback-error="description"]').textContent).toMatch(
      /describe/,
    );
    expect(document.activeElement?.name).toBe('description');
  });

  it('shows success in the modal after a 202 response', async () => {
    fetch.mockResolvedValueOnce({ status: 202 });
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#footer-open').click();
    const form = root.querySelector('[data-feedback-form]');
    form.description.value = 'Great app';
    form.querySelector('[data-feedback-submit]').disabled = false;
    form.requestSubmit();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-feedback-success-panel]').hidden).toBe(false);
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps input and shows an error when send fails', async () => {
    fetch.mockResolvedValueOnce({ status: 502 });
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#cta-open').click();
    const form = root.querySelector('[data-feedback-form]');
    form.description.value = 'Still here';
    form.querySelector('[data-feedback-submit]').disabled = false;
    form.requestSubmit();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-feedback-alert]').hidden).toBe(false);
    });
    expect(form.description.value).toBe('Still here');
    expect(root.querySelector('[data-feedback-form-panel]').hidden).toBe(false);
  });

  it('does not submit or show success when the honeypot is filled', async () => {
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#cta-open').click();
    const form = root.querySelector('[data-feedback-form]');
    form.description.value = 'Bot';
    form.website.value = 'spam';
    form.querySelector('[data-feedback-submit]').disabled = false;
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('[data-feedback-success-panel]').hidden).toBe(true);
  });

  it('resets the same form markup when sending another', async () => {
    fetch.mockResolvedValueOnce({ status: 202 });
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#cta-open').click();
    const form = root.querySelector('[data-feedback-form]');
    form.description.value = 'First note';
    form.querySelector('[data-feedback-submit]').disabled = false;
    form.requestSubmit();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-feedback-success-panel]').hidden).toBe(false);
    });
    root.querySelector('[data-feedback-send-another]').click();
    expect(root.querySelector('[data-feedback-form]')).toBe(form);
    expect(form.description.value).toBe('');
    expect(document.activeElement?.name).toBe('description');
  });

  it('keeps the honeypot off-screen at narrow widths', () => {
    window.innerWidth = 375;
    window.innerHeight = 812;
    window.dispatchEvent(new Event('resize'));
    const root = buildFeedbackDom({ withCss: true });
    initFeedback(root);
    root.querySelector('#cta-open').click();
    const honeypot = root.querySelector('.feedback-honeypot');
    const website = root.querySelector('[name="website"]');
    expect(honeypot?.getAttribute('aria-hidden')).toBe('true');
    expect(website?.getAttribute('tabindex')).toBe('-1');
    expect(website?.getAttribute('autocomplete')).toBe('off');
    const style = getComputedStyle(honeypot);
    expect(style.position).toBe('absolute');
    expect(style.clipPath).toBe('inset(50%)');
    expect(honeypot?.offsetWidth).toBeLessThanOrEqual(1);
    expect(honeypot?.offsetHeight).toBeLessThanOrEqual(1);
  });

  it('uses stacked fields and full-width inputs on mobile', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const mainCss = readFileSync(join(dir, '../css/main.css'), 'utf8');
    expect(mainCss).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.feedback-actions[\s\S]*flex-direction: column-reverse/,
    );

    window.innerWidth = 375;
    window.innerHeight = 812;
    window.dispatchEvent(new Event('resize'));
    const root = buildFeedbackDom({ withCss: true });
    initFeedback(root);
    root.querySelector('#footer-open').click();
    const card = root.querySelector('.feedback-dialog__card');
    const field = root.querySelector('.feedback-field');
    const textarea = root.querySelector('textarea.feedback-input--area');
    const cardStyle = getComputedStyle(card);
    expect(parseFloat(cardStyle.borderTopWidth)).toBeGreaterThan(0);
    expect(cardStyle.borderRadius).not.toBe('');
    expect(getComputedStyle(field).flexDirection).toBe('column');
    expect(getComputedStyle(textarea).width).toBe('100%');
    expect(root.querySelector('.feedback-dialog').classList.contains('feedback-dialog')).toBe(true);
  });
});
