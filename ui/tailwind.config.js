/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:        '#0a0a0f',
        surface:   '#13131a',
        surface2:  '#1a1a24',
        border:    '#1e1e2e',
        borderhi:  '#2e2e4e',
        text:      '#f8fafc',
        muted:     '#94a3b8',
        dim:       '#64748b',
        faint:     '#475569',
        accent:    '#6366f1',
        accent2:   '#8b5cf6',
        success:   '#10b981',
        danger:    '#ef4444',
        warn:      '#f59e0b',
        crimson:   '#dc2626',
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
        card:    '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
        glow:    '0 0 32px rgba(99,102,241,0.25)',
        glowred: '0 0 32px rgba(220,38,38,0.25)',
        hero:    '0 24px 64px -16px rgba(99,102,241,0.35)',
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
