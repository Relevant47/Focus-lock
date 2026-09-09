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

/** Open the unlock modal. Resolves once verify_parent_pin succeeds, rejects if the user cancels. */
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
 * prompt the user, then retry exactly once. Other errors propagate unchanged.
 *
 * If the daemon still refuses after the retry (rare — the parent token
 * granted by verify_parent_pin should satisfy the gate) we rethrow a
 * user-facing message rather than leaking the raw `parent_lock_required`
 * code string to the UI.
 */
export async function withParentGate<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!isParentLockRequired(err)) throw err;
    await promptParentUnlock();
    try {
      return await action();
    } catch (retryErr) {
      if (!isParentLockRequired(retryErr)) throw retryErr;
      const friendly = new Error('Parent PIN required to continue.') as DaemonError;
      friendly.code = 'parent_lock_required';
      throw friendly;
    }
  }
}
