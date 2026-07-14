// Cross-component plumbing for parental controls.
//
// When the daemon rejects a gated command with code `parent_lock_required`,
// `withParentGate` opens the unlock modal, waits for the user to enter the PIN,
// then retries the original action. The modal is mounted globally in <App>.

type Resolver = () => void;
type Rejecter = (err: unknown) => void;

interface PendingPrompt {
  resolve: Resolver;
  reject: Rejecter;
}

let listener: ((p: PendingPrompt) => void) | null = null;

export function registerParentUnlockListener(fn: (p: PendingPrompt) => void) {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/**
 * Thrown by the unlock modal when the user dismisses it (Cancel button or
 * backdrop click). Distinguished from real verification failures so callers
 * — and `withParentGate` itself — can swallow it silently instead of
 * surfacing "Parent unlock cancelled" in a red error banner.
 */
export class ParentUnlockCancelledError extends Error {
  constructor() {
    super('Parent unlock cancelled');
    this.name = 'ParentUnlockCancelledError';
  }
}

/** Open the unlock modal. Resolves once verify_parent_pin succeeds, rejects with `ParentUnlockCancelledError` if the user cancels. */
export function promptParentUnlock(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!listener) { reject(new Error('Parent unlock modal not mounted')); return; }
    listener({ resolve, reject });
  });
}

export interface DaemonError extends Error {
  code?: string;
}

function isParentLockRequired(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as DaemonError;
    if (e.code === 'parent_lock_required') return true;
    // Fallback for callers that lost the code somehow
    if (e.message?.toLowerCase().includes('parent pin required')) return true;
  }
  return false;
}

/**
 * Wrap a gated mutation. If the daemon refuses with `parent_lock_required`,
 * prompt the user, then retry exactly once. If the user cancels the prompt,
 * resolves to `undefined` — callers should treat that as "user chose not to
 * proceed" and neither surface an error nor perform side-effects. Other
 * errors propagate unchanged.
 */
export async function withParentGate<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    if (!isParentLockRequired(err)) throw err;
    try {
      await promptParentUnlock();
    } catch (promptErr) {
      if (promptErr instanceof ParentUnlockCancelledError) return undefined;
      throw promptErr;
    }
    return action();
  }
}
