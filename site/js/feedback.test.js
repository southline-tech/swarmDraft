import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  MESSAGE_COUNTER_FROM,
  buildLandingPayload,
  feedbackErrorMessage,
  formatMessageCounter,
  validateFeedbackForm,
} from './feedback.js';

describe('landing feedback form helpers', () => {
  it('validates description and optional email', () => {
    expect(validateFeedbackForm('', '')).toEqual({
      description: 'Please describe your feedback.',
    });
    expect(validateFeedbackForm('Hello', 'not-an-email')).toEqual({
      replyEmail: "That email doesn't look right.",
    });
    expect(validateFeedbackForm('Hello', 'writer@example.com')).toEqual({});
  });

  it('rejects messages over the landing limit', () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(validateFeedbackForm(long, '')).toEqual({
      description: `Feedback must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
    });
  });

  it('shows the character counter from the threshold', () => {
    expect(formatMessageCounter(MESSAGE_COUNTER_FROM)).toBe('200 characters left');
    expect(formatMessageCounter(MAX_MESSAGE_LENGTH)).toBe('0 characters left');
    expect(formatMessageCounter(MAX_MESSAGE_LENGTH - 1)).toBe('1 character left');
  });

  it('builds landing payload with fixed type and area', () => {
    const payload = buildLandingPayload({
      description: '  Idea  ',
      replyEmail: 'a@b.co',
      installId: '550e8400-e29b-41d4-a716-446655440000',
      siteVersion: '0.1.1',
    });
    expect(payload.area).toBe('other');
    expect(payload.type).toBe('idea');
    expect(payload.source).toBe('landing');
    expect(payload.description).toBe('Idea');
    expect(payload.replyEmail).toBe('a@b.co');
    expect(payload.website).toBe('');
  });

  it('maps HTTP errors to writer copy', () => {
    expect(feedbackErrorMessage(429)).toMatch(/Too many/);
    expect(feedbackErrorMessage(502)).toMatch(/unavailable/);
    expect(feedbackErrorMessage(0)).toMatch(/Couldn't send/);
  });
});
