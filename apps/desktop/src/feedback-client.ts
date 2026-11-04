import { invoke } from '@tauri-apps/api/core';

export const FEEDBACK_AREAS = ['editor', 'review', 'export', 'agents', 'install', 'other'] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_TYPES = ['bug', 'idea', 'question'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_AREA_LABELS: Record<FeedbackArea, string> = {
  editor: 'Editor',
  review: 'Review & suggestions',
  export: 'Export',
  agents: 'Agents & bots',
  install: 'Install & updates',
  other: 'Other',
};

export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Something broke',
  idea: 'Idea',
  question: 'Question',
};

export interface SendFeedbackInput {
  area: FeedbackArea;
  type: FeedbackType;
  description: string;
  replyEmail?: string;
  includeText?: boolean;
  excerpt?: string;
  includeDiagnostics?: boolean;
  screenshotPng?: string;
}

export interface FeedbackPendingSummary {
  id: string;
  agentId: string;
  agentName: string;
  area: FeedbackArea;
  type: FeedbackType;
  description: string;
  excerpt?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface FeedbackApi {
  send: (input: SendFeedbackInput) => Promise<void>;
  listPending: () => Promise<FeedbackPendingSummary[]>;
  approve: (feedbackId: string, opts?: { includeExcerpt?: boolean }) => Promise<void>;
  deny: (feedbackId: string) => Promise<void>;
}

export const feedbackApi: FeedbackApi = {
  send: (input) => invoke('send_feedback', { input }),
  listPending: () => invoke<FeedbackPendingSummary[]>('list_pending_feedback'),
  approve: (feedbackId, opts) =>
    invoke('approve_feedback', {
      feedbackId,
      includeExcerpt: opts?.includeExcerpt ?? false,
    }),
  deny: (feedbackId) => invoke('deny_feedback', { feedbackId }),
};

export function feedbackErrorMessage(code: string): string {
  switch (code) {
    case 'offline':
      return "Couldn't reach the feedback server. Check your internet connection and try again.";
    case 'rate_limited':
      return 'Too many feedback messages recently. Wait a bit, then try again.';
    case 'unavailable':
      return "Feedback isn't available right now. Try again later.";
    default:
      return "Couldn't send feedback. Try again.";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFeedbackForm(description: string, replyEmail: string): string | null {
  if (!description.trim()) return 'Add a message.';
  const email = replyEmail.trim();
  if (email && !EMAIL_RE.test(email)) return 'Enter a valid email address.';
  return null;
}
