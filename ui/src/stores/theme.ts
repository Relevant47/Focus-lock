const STORAGE_KEY = 'focuslock_theme';

export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'dark';
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}
