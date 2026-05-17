import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, ...rest }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Dashboard: (p: Props) => <Base {...p}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></Base>,
  Block:     (p: Props) => <Base {...p}><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></Base>,
  Profile:   (p: Props) => <Base {...p}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5M8 17h3"/></Base>,
  Calendar:  (p: Props) => <Base {...p}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></Base>,
  Chart:     (p: Props) => <Base {...p}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></Base>,
  Settings:  (p: Props) => <Base {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Base>,
  Play:      (p: Props) => <Base {...p}><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></Base>,
  Pause:     (p: Props) => <Base {...p}><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/></Base>,
  Skip:      (p: Props) => <Base {...p}><polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none"/><line x1="19" y1="5" x2="19" y2="19"/></Base>,
  Stop:      (p: Props) => <Base {...p}><rect x="6" y="6" width="12" height="12" rx="2"/></Base>,
  Lock:      (p: Props) => <Base {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></Base>,
  Flame:     (p: Props) => <Base {...p}><path d="M12 22c4.5 0 7-3 7-7 0-3-2-5-3-7 0-2 1-4 1-4s-3 1-5 5c-1 2-3 3-3 6 0 4 2 7 3 7z"/></Base>,
  Shield:    (p: Props) => <Base {...p}><path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z"/></Base>,
  ShieldChk: (p: Props) => <Base {...p}><path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z"/><path d="M9 12l2 2 4-4"/></Base>,
  Handshake: (p: Props) => <Base {...p}><path d="M2 12l4-4 4 1 3-2 4 1 5 4-3 5-5-3-3 3-4-1z"/></Base>,
  Sunrise:   (p: Props) => <Base {...p}><path d="M12 3v5M5 12h2M17 12h2M6 19h12M9 16a3 3 0 0 1 6 0M4 8l1.5 1.5M19.5 9.5L20 8"/></Base>,
  Moon:      (p: Props) => <Base {...p}><path d="M21 13a8 8 0 1 1-10-10 7 7 0 0 0 10 10z"/></Base>,
  Mountain:  (p: Props) => <Base {...p}><path d="M3 20l5-9 4 6 3-4 6 7z"/></Base>,
  CalCheck:  (p: Props) => <Base {...p}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/></Base>,
  Plus:      (p: Props) => <Base {...p}><path d="M12 5v14M5 12h14"/></Base>,
  Search:    (p: Props) => <Base {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></Base>,
  Close:     (p: Props) => <Base {...p}><path d="M6 6l12 12M18 6L6 18"/></Base>,
  Check:     (p: Props) => <Base {...p}><path d="M5 13l4 4 10-10"/></Base>,
  Arrow:     (p: Props) => <Base {...p}><path d="M5 12h14M13 6l6 6-6 6"/></Base>,
  Sparkle:   (p: Props) => <Base {...p}><path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3"/></Base>,
  Trophy:    (p: Props) => <Base {...p}><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/></Base>,
  Target:    (p: Props) => <Base {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></Base>,
  Bell:      (p: Props) => <Base {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8z"/><path d="M10 21a2 2 0 0 0 4 0"/></Base>,
  Brand:     (p: Props) => (
    <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" {...p}>
      <line x1="12" y1="12" x2="50" y2="50" />
      <line x1="88" y1="12" x2="50" y2="50" />
      <line x1="12" y1="88" x2="50" y2="50" />
      <line x1="88" y1="88" x2="50" y2="50" />
      <circle cx="50" cy="50" r="4" fill="currentColor" />
    </svg>
  ),
};
