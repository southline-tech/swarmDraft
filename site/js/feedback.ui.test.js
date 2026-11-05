// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initFeedback } from './feedback.js';

function buildFeedbackDom() {
  document.body.dataset.siteVersion = '0.1.1';
  document.body.innerHTML = `
      <button type="button" data-feedback-open id="cta-open">Send feedback</button>
      <button type="button" data-feedback-open id="footer-open">Footer</button>
      <dialog data-feedback-dialog aria-labelledby="feedback-modal-title">
        <div class="feedback-dialog__card">
          <button type="button" data-feedback-close aria-label="Close">Close</button>
          <div data-feedback-form-panel>
            <h2 id="feedback-modal-title">Send feedback</h2>
            <form data-feedback-form data-state="idle" novalidate>
              <textarea name="description" id="feedback-description" maxlength="2000"></textarea>
              <p data-feedback-counter aria-live="off" hidden></p>
              <p data-feedback-error="description" id="feedback-description-error"></p>
              <input type="email" name="replyEmail" id="feedback-email" aria-describedby="feedback-email-hint" />
              <p data-feedback-error="replyEmail" id="feedback-reply-error"></p>
              <input type="text" name="website" tabindex="-1" autocomplete="off" />
              <p data-feedback-alert role="alert" hidden></p>
              <button type="button" data-feedback-cancel>Cancel</button>
              <button type="submit" data-feedback-submit disabled>
                <span class="feedback-submit__label">Send feedback</span>
                <span data-feedback-spinner hidden></span>
              </button>
            </form>
          </div>
          <div data-feedback-success-panel hidden>
            <p data-feedback-success-status tabindex="-1" role="status">Thanks</p>
            <button type="button" data-feedback-close-panel>Close</button>
            <button type="button" data-feedback-send-another>Send another</button>
          </div>
        </div>
      </dialog>
  `;
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
});
