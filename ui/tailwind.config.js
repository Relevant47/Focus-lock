/** @type {import('tailwindcss').Config} */
//
// Colors here are CSS-variable references with Tailwind's `<alpha-value>`
// placeholder, NOT literal hex codes — that's what makes both `bg-bg` AND
// `bg-accent/15` flip when we toggle data-theme on <html>.
//
// How it works:
//   1. index.css defines space-separated RGB triples per theme, e.g.
//      `--accent-rgb: 99 102 241;` (dark) or `91 79 232` (light).
//   2. Here we wrap each token as `rgb(var(--accent-rgb) / <alpha-value>)`.
//   3. Tailwind substitutes `<alpha-value>` with `1` for `bg-accent` and
//      with `0.15` for `bg-accent/15`, giving correct rgb() at runtime.
//
// Token map (Tailwind key → CSS var):
//   bg/surface/surface2/sidebar/hover/active/border/borderhi
//   text/muted/dim/faint/accent/accent2/success/danger/warn/crimson/toggle
//
// Anything addressed in raw CSS (gradients, box-shadows) reads from the
// plain `--accent`, `--shadow`, etc. variables instead — those also live
// in index.css.
function v(name) {
  return `rgb(var(${name}) / <alpha-value>)`;
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:        v('--bg-rgb'),
        surface:   v('--surface-rgb'),
        surface2:  v('--surface-2-rgb'),
        sidebar:   v('--sidebar-rgb'),
        hover:     v('--hover-rgb'),
        active:    v('--active-rgb'),
        border:    v('--border-rgb'),
        borderhi:  v('--border-hi-rgb'),
        text:      v('--text-rgb'),
        muted:     v('--muted-rgb'),
        dim:       v('--dim-rgb'),
        faint:     v('--faint-rgb'),
        accent:    v('--accent-rgb'),
        accent2:   v('--accent-2-rgb'),
        success:   v('--success-rgb'),
        danger:    v('--danger-rgb'),
        warn:      v('--warn-rgb'),
        crimson:   v('--crimson-rgb'),
        toggle:    v('--toggle-rgb'),
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        tightish: '-0.015em',
        tighter2: '-0.02em',
      },
      boxShadow: {
        card:    '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 var(--shadow)',
        glow:    '0 0 32px rgba(99,102,241,0.25)',
        glowred: '0 0 32px rgba(220,38,38,0.25)',
        hero:    '0 24px 64px -16px rgba(99,102,241,0.35)',
        soft:    '0 2px 8px var(--shadow)',
      },
      keyframes: {
        'fade-up':   { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'fade-in':   { from: { opacity: 0 }, to: { opacity: 1 } },
        'scale-in':  { from: { opacity: 0, transform: 'scale(0.96)' }, to: { opacity: 1, transform: 'scale(1)' } },
        'soft-pulse':{ '0%,100%': { opacity: 1 }, '50%': { opacity: 0.5 } },
        'glow-pulse':{ '0%,100%': { boxShadow: '0 0 0 0 rgba(99,102,241,0.45)' }, '50%': { boxShadow: '0 0 0 6px rgba(99,102,241,0)' } },
        'shimmer':   { from: { backgroundPosition: '-200% 0' }, to: { backgroundPosition: '200% 0' } },
        'toast-in':  { from: { opacity: 0, transform: 'translateY(8px) scale(0.96)' }, to: { opacity: 1, transform: 'translateY(0) scale(1)' } },
      },
      animation: {
        'fade-up':    'fade-up 180ms ease-out both',
        'fade-in':    'fade-in 180ms ease-out both',
        'scale-in':   'scale-in 200ms cubic-bezier(0.16,1,0.3,1) both',
        'soft-pulse': 'soft-pulse 2.4s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'shimmer':    'shimmer 2.4s linear infinite',
        'toast-in':   'toast-in 240ms cubic-bezier(0.16,1,0.3,1) both',
      },
    },
  },
  plugins: [],
};
