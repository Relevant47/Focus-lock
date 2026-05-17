import { useEffect, useState } from 'react';

const COLORS = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#22d3ee'];

interface Piece { id: number; left: number; dx: number; dy: number; color: string; delay: number; size: number; }

export default function Confetti({ trigger, count = 60 }: { trigger: number; count?: number }) {
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (!trigger) return;
    const next: Piece[] = Array.from({ length: count }, (_, i) => ({
      id: trigger * 1000 + i,
      left: 50 + (Math.random() - 0.5) * 30,
      dx: (Math.random() - 0.5) * 400,
      dy: 200 + Math.random() * 300,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 0.15,
      size: 6 + Math.random() * 6,
    }));
    setPieces(next);
    const t = setTimeout(() => setPieces([]), 2000);
    return () => clearTimeout(t);
  }, [trigger, count]);

  if (pieces.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`, top: '20%',
            width: p.size, height: p.size * 1.5,
            background: p.color,
            ['--dx' as any]: `${p.dx}px`,
            ['--dy' as any]: `${p.dy}px`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
