// @vitest-environment happy-dom
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    expect(css).toMatch(/\.feedback-actions\s*\{[^}]*bottom:\s*0;/);
    expect(css).not.toMatch(/\.feedback-actions\s*\{[^}]*bottom:\s*var\(--feedback-keyboard-inset/);
    expect(css).toMatch(
      /\.feedback-dialog__card\s*\{[^}]*margin-bottom:\s*var\(--feedback-keyboard-inset,\s*0px\)/,
    );
    expect(css).toMatch(
      /max-height:\s*min\(92vh,\s*calc\(100vh - var\(--feedback-keyboard-inset,\s*0px\)\)\)/,
    );
    expect(css).not.toMatch(/padding-bottom:[\s\S]{0,240}--feedback-keyboard-inset/);
    expect(css).not.toMatch(/\.footer-link-btn/);
  });

  it('lifts the send row by the keyboard inset when the visual viewport shrinks', () => {
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
    const root = buildFeedbackDom({ withCss: true });
    initFeedback(root);
    root.querySelector('#feedback').click();
    const card = root.querySelector('.feedback-dialog__card');
    const actions = card.querySelector('.feedback-actions');
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('480px');
    expect(getComputedStyle(actions).bottom).toBe('0px');
    expect(getComputedStyle(card).marginBottom).toBe('480px');
    expect(getComputedStyle(card).paddingBottom.includes('480')).toBe(false);
    viewport.height = 800;
    listeners.resize();
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('0px');
    expect(getComputedStyle(actions).bottom).toBe('0px');
    expect(getComputedStyle(card).marginBottom).toBe('0px');
    root.querySelector('[data-feedback-close]').click();
    expect(card.style.getPropertyValue('--feedback-keyboard-inset')).toBe('');
    expect(listeners.resize).toBeUndefined();

    const laidOut = measureFeedbackSheetInChrome();
    const open = laidOut.withKeyboard;
    expect(open.innerWidth).toBeLessThanOrEqual(640);
    expect(Math.abs(open.card.bottom - open.vvBottom)).toBeLessThanOrEqual(1);
    expect(open.actions.top).toBeGreaterThanOrEqual(open.vvTop - 1);
    expect(open.actions.bottom).toBeLessThanOrEqual(open.vvBottom + 1);
    expect(open.actions.bottom).toBeLessThanOrEqual(open.card.bottom + 1);
    const messageFits =
      open.message.top >= open.card.top - 1 && open.message.bottom <= open.actions.top + 1;
    const messageScrollsIntoGap =
      open.scrollHeight > open.clientHeight + 1 &&
      open.message.top < open.actions.top &&
      open.message.bottom > open.card.top;
    expect(messageFits || messageScrollsIntoGap).toBe(true);
  });
});

function chromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Phone-sheet boxes from real Chrome. happy-dom's getBoundingClientRect is a zero stub. */
function measureFeedbackSheetInChrome() {
  const chrome = chromeBinary();
  if (!chrome) throw new Error('Chrome is required to measure the feedback sheet');
  const dir = dirname(fileURLToPath(import.meta.url));
  const cssDir = join(dir, '../css');
  const work = mkdtempSync(join(tmpdir(), 'feedback-sheet-'));
  const htmlPath = join(work, 'index.html');
  writeFileSync(
    htmlPath,
    `<!doctype html>
<html><head>
<link rel="stylesheet" href="file://${cssDir}/tokens.css">
<link rel="stylesheet" href="file://${cssDir}/main.css">
</head><body>
<dialog class="feedback-dialog">
  <div class="feedback-dialog__card">
    <h2 class="feedback-dialog__title">Send feedback</h2>
    <form class="feedback-form">
      <div class="feedback-field">
        <label class="feedback-label" for="feedback-description">Your message</label>
        <textarea class="feedback-input feedback-input--area" id="feedback-description"></textarea>
      </div>
      <div class="feedback-field">
        <label class="feedback-label" for="feedback-email">Email (optional)</label>
        <input class="feedback-input" id="feedback-email" />
      </div>
      <div class="feedback-actions">
        <button class="btn btn--ghost" type="button">Cancel</button>
        <button class="btn btn--primary" type="submit">Send feedback</button>
      </div>
    </form>
  </div>
</dialog>
<pre id="layout"></pre>
<script>
  const dialog = document.querySelector('dialog');
  dialog.style.transition = 'none';
  const card = document.querySelector('.feedback-dialog__card');
  const actions = document.querySelector('.feedback-actions');
  const message = document.querySelector('#feedback-description');
  dialog.showModal();
  const snap = (inset) => {
    card.style.setProperty('--feedback-keyboard-inset', inset + 'px');
    const vvTop = 0;
    const vvBottom = window.innerHeight - inset;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      vvTop,
      vvBottom,
      card: box(card),
      actions: box(actions),
      message: box(message),
      scrollHeight: card.scrollHeight,
      clientHeight: card.clientHeight,
    };
  };
  const inset = Math.round(window.innerHeight * 0.6);
  document.getElementById('layout').textContent = JSON.stringify({ withKeyboard: snap(inset) });
</script>
</body></html>`,
  );
  try {
    const res = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--force-prefers-reduced-motion',
        `--user-data-dir=${work}/profile`,
        '--window-size=390,800',
        '--dump-dom',
        `file://${htmlPath}`,
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) {
      throw new Error(res.stderr || `chrome exited ${res.status}`);
    }
    const match = res.stdout.match(/<pre id="layout">([\s\S]*?)<\/pre>/);
    if (!match) throw new Error('chrome did not report feedback sheet layout');
    return JSON.parse(match[1]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
