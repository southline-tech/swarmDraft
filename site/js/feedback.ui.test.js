// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_UI_TEMPLATE_ID,
  getFocusableElements,
  initFeedback,
  mountFeedbackUi,
  scheduleFeedbackInit,
} from './feedback.js';

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
          <div class="visually-hidden" aria-hidden="true">
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
      <footer>
        <a href="#feedback" id="feedback" data-feedback-open>Send feedback</a>
      </footer>
      <dialog class="feedback-dialog" data-feedback-dialog aria-modal="true" aria-labelledby="feedback-modal-title">
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
    const trigger = root.querySelector('#feedback');
    const dialog = root.querySelector('[data-feedback-dialog]');
    trigger.focus();
    trigger.click();
    expect(dialog.open).toBe(true);
    expect(document.activeElement?.id).toBe('feedback-description');
    root.querySelector('[data-feedback-close]').click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('shows validation errors without submitting', async () => {
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#feedback').click();
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
    root.querySelector('#feedback').click();
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
    root.querySelector('#feedback').click();
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
    root.querySelector('#feedback').click();
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
    root.querySelector('#feedback').click();
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
    root.querySelector('#feedback').click();
    const honeypot = root.querySelector('.visually-hidden');
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
      /@media \(max-width: 640px\)[\s\S]*\.feedback-actions[\s\S]*flex-direction: column-reverse/,
    );

    window.innerWidth = 375;
    window.innerHeight = 812;
    window.dispatchEvent(new Event('resize'));
    const root = buildFeedbackDom({ withCss: true });
    initFeedback(root);
    root.querySelector('#feedback').click();
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

  it('closes on Escape and backdrop click', () => {
    const root = buildFeedbackDom();
    initFeedback(root);
    const dialog = root.querySelector('[data-feedback-dialog]');
    root.querySelector('#feedback').click();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.open).toBe(false);
    root.querySelector('#feedback').click();
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it('keeps Tab focus inside the visible panel only', async () => {
    fetch.mockResolvedValueOnce({ status: 202 });
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#feedback').click();
    const card = root.querySelector('.feedback-dialog__card');
    const formFocusables = getFocusableElements(card);
    expect(formFocusables.some((el) => el.matches('[data-feedback-send-another]'))).toBe(false);
    const last = formFocusables[formFocusables.length - 1];
    last.focus();
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(formFocusables[0]);

    const form = root.querySelector('[data-feedback-form]');
    form.description.value = 'Done';
    form.querySelector('[data-feedback-submit]').disabled = false;
    form.requestSubmit();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-feedback-success-panel]').hidden).toBe(false);
    });
    const successFocusables = getFocusableElements(card);
    expect(successFocusables.some((el) => el.matches('[data-feedback-submit]'))).toBe(false);
  });

  it('resets counter aria-live after each throttled announcement', () => {
    vi.useFakeTimers();
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#feedback').click();
    const form = root.querySelector('[data-feedback-form]');
    const counter = root.querySelector('[data-feedback-counter]');
    form.description.value = 'x'.repeat(1800);
    form.description.dispatchEvent(new Event('input', { bubbles: true }));
    expect(counter.getAttribute('aria-live')).toBe('polite');
    form.description.value = 'x'.repeat(1801);
    form.description.dispatchEvent(new Event('input', { bubbles: true }));
    expect(counter.getAttribute('aria-live')).toBe('polite');
    vi.advanceTimersByTime(400);
    expect(counter.getAttribute('aria-live')).toBe('off');
    form.description.value = 'x'.repeat(1802);
    form.description.dispatchEvent(new Event('input', { bubbles: true }));
    expect(counter.getAttribute('aria-live')).toBe('polite');
    vi.useRealTimers();
  });

  it('opens the dialog when the page loads with #feedback', () => {
    window.location.hash = '#feedback';
    const root = buildFeedbackDom();
    initFeedback(root);
    expect(root.querySelector('[data-feedback-dialog]').open).toBe(true);
    window.location.hash = '';
  });

  it('scheduleFeedbackInit runs immediately when document is already ready', () => {
    expect(document.readyState).not.toBe('loading');
    const root = buildFeedbackDom();
    scheduleFeedbackInit(root);
    const dialog = root.querySelector('[data-feedback-dialog]');
    root.querySelector('#feedback').click();
    expect(dialog.open).toBe(true);
  });

  it('index.html exposes only the footer Send feedback entry with #feedback', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(dir, '../index.html'), 'utf8');
    expect(html).not.toMatch(/Tell us what you think/);
    expect(html).not.toMatch(/feedback-cta/);
    expect(html).toMatch(/<a href="#feedback" id="feedback" data-feedback-open>Send feedback<\/a>/);
    expect(html).toMatch(/Feedback needs JavaScript turned on/);
    expect(html.match(/data-feedback-open/g)?.length).toBe(1);
    expect(html).toMatch(/css\/main\.css\?v=0\.1\.1/);
    expect(html).toMatch(/css\/tokens\.css\?v=0\.1\.1/);
  });

  it('hides the success panel and honeypot while the form is open', () => {
    const root = buildFeedbackDom({ withCss: true });
    initFeedback(root);
    root.querySelector('#feedback').click();
    const success = root.querySelector('[data-feedback-success-panel]');
    const honey = root.querySelector('.visually-hidden');
    expect(success?.hidden).toBe(true);
    expect(getComputedStyle(success).display).toBe('none');
    expect(getComputedStyle(honey).clipPath).toBe('inset(50%)');
    expect(honey?.offsetWidth).toBeLessThanOrEqual(1);
    const card = root.querySelector('.feedback-dialog__card');
    const dialog = root.querySelector('.feedback-dialog');
    expect(['0px', 'initial']).toContain(getComputedStyle(dialog).borderTopWidth);
    expect(parseFloat(getComputedStyle(card).borderRadius)).toBeGreaterThan(0);
  });

  it('main.css forces [hidden] panels off and styles the dialog card', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, '../css/main.css'), 'utf8');
    expect(css).toMatch(/display:\s*none\s*!important/);
    expect(css).toMatch(/\.feedback-dialog\s*\{[\s\S]*?border:\s*none\s*!important/);
    expect(css).toMatch(
      /\.feedback-dialog__card\s*\{[\s\S]*?border-radius:\s*var\(--ct-radius-lg\)/,
    );
    expect(css).toMatch(/\.feedback-dialog::backdrop\s*\{[\s\S]*?--ct-scrim/);
    expect(css).toMatch(/--feedback-keyboard-inset/);
    expect(css).not.toMatch(/\.footer-link-btn/);
  });

  it('pads the dialog card when the visual viewport shrinks', () => {
    const listeners = {};
    const viewport = {
      height: 320,
      offsetTop: 0,
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type, fn) {
        if (listeners[type] === fn) delete listeners[type];
      },
    };
    vi.stubGlobal('visualViewport', viewport);
    window.innerHeight = 800;
    const root = buildFeedbackDom();
    initFeedback(root);
    root.querySelector('#feedback').click();
    const card = root.querySelector('.feedback-dialog__card');
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('480px');
    viewport.height = 800;
    listeners.resize();
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('0px');
    root.querySelector('[data-feedback-close]').click();
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('');
    expect(listeners.resize).toBeUndefined();
  });
});
