/**
 * Per-meeting draft of the "context for AI summary" box.
 *
 * The box feeds the summary prompt, but the typed text used to live only in
 * component state, so leaving the meeting threw it away. Keeping it in web
 * storage makes the draft survive navigation and app restarts.
 *
 * This is a draft, not meeting content: it is deliberately kept out of the
 * meeting folder, and losing it is never worse than the old behaviour.
 */

const DRAFT_KEY_PREFIX = 'summary-context-draft:';

/** Minimal surface this module needs, so tests can pass a fake. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function summaryContextDraftKey(meetingId: string): string {
  return `${DRAFT_KEY_PREFIX}${meetingId}`;
}

/**
 * Storage access can throw outright when site data is disabled, so every call
 * is guarded and falls back to "no draft".
 */
export function readSummaryContextDraft(
  storage: DraftStorage | null | undefined,
  meetingId: string | null | undefined
): string {
  if (!storage || !meetingId) {
    return '';
  }

  try {
    return storage.getItem(summaryContextDraftKey(meetingId)) ?? '';
  } catch {
    return '';
  }
}

export function writeSummaryContextDraft(
  storage: DraftStorage | null | undefined,
  meetingId: string | null | undefined,
  value: string
): void {
  if (!storage || !meetingId) {
    return;
  }

  const key = summaryContextDraftKey(meetingId);
  try {
    // An emptied box means "no context", so drop the key rather than keep a
    // blank one around for the next read to resurrect.
    if (value.trim().length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, value);
  } catch {
    // Storage is unavailable; the draft simply does not persist.
  }
}

/** The browser store, or null where there is no window (SSR/prerender). */
export function defaultDraftStorage(): DraftStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
