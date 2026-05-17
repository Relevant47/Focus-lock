// Ambient background — soft drifting aurora gradients + film grain overlay.
// Sits fixed behind every page at z:0 with pointer-events:none so it never
// intercepts clicks. Cheap (just transform/opacity animations + 1 SVG noise).
export default function Aurora() {
  return (
    <>
      <div className="aurora" aria-hidden="true">
        <div className="aurora-orb aurora-orb-1" />
        <div className="aurora-orb aurora-orb-2" />
        <div className="aurora-orb aurora-orb-3" />
      </div>
      <div className="grain" aria-hidden="true" />
    </>
  );
}
