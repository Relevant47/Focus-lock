// Theme store + applier.
//
// Three user-selectable values are persisted: 'dark', 'light', 'system'.
//   - 'dark' / 'light' force the corresponding palette regardless of OS prefs.
//   - 'system' follows window.matchMedia('(prefers-color-scheme: light)'),
//     and re-applies live when the OS toggles.
//
// The *resolved* theme (dark | light) is what's written to the
// `data-theme` attribute on <html>. That attribute is the single source of
// truth that the CSS in index.css keys off of — everything else (Tailwind
// classes, raw CSS) reads the matching CSS custom properties.
//
// First-launch behaviour: if the user has never set a preference, we default
// to 'system' so the app follows OS taste out of the box.

const STORAGE_KEY = 'focuslock_theme';

export type Theme = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

// Module-level state — applyTheme() stores the active OS-pref listener here
// so a subsequent applyTheme() call can cleanly tear it down. Without this
// we'd accumulate matchMedia listeners every time the user clicks the
// Appearance toggle.
let mql: MediaQueryList | null = null;
let mqlListener: ((e: MediaQueryListEvent) => void) | null = null;

export function getTheme(): Theme {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  return 'system';
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Resolve a Theme to the concrete dark/light value to render. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') {
    if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

/** Apply `theme` to the document, wiring up an OS listener if needed. */
export function applyTheme(theme: Theme) {
  // Tear down any previous listener — otherwise switching from 'system' to
  // 'dark' would leave us still re-applying on OS pref changes.
  if (mql && mqlListener) {
    mql.removeEventListener('change', mqlListener);
    mql = null;
    mqlListener = null;
  }

  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);

  // For 'system', subscribe to OS pref changes so the page updates live
  // (e.g. user flips Windows dark mode while FocusLock is open).
  if (theme === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    mql = window.matchMedia('(prefers-color-scheme: light)');
    mqlListener = (e: MediaQueryListEvent) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    };
    mql.addEventListener('change', mqlListener);
  }
}
