// First-time walkthrough shown the first time a user opens the Family tab.
// Explains the parent/child model honestly, then routes to the right next
// action. Dismissible — once dismissed it never reappears for that install.

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Icon } from './Icons';
import { cn } from '../lib/cn';

const STORAGE_KEY = 'focus-lock:family-onboarding-done';

export function useFamilyOnboarding() {
  const [done, setDone] = useState(() => !!localStorage.getItem(STORAGE_KEY));
  function complete() { localStorage.setItem(STORAGE_KEY, '1'); setDone(true); }
  function reset() { localStorage.removeItem(STORAGE_KEY); setDone(false); }
  return { showOnboarding: !done, complete, reset };
}

type Role = 'parent' | 'child' | null;
type Step = 'welcome' | 'role' | 'parent-plan' | 'child-plan';

export default function FamilyOnboarding({
  onDone,
  onPickPair,
}: {
  onDone: () => void;
  /// Called when the child path is selected — Family.tsx jumps the signed-out
  /// view to the "I have a pairing code" tab instead of login/signup.
  onPickPair: () => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [role, setRole] = useState<Role>(null);

  function chooseRole(r: Role) {
    setRole(r);
    setStep(r === 'parent' ? 'parent-plan' : 'child-plan');
  }

  function finish() {
    if (role === 'child') onPickPair();
    onDone();
  }

  return (
    <div className="modal-backdrop">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero overflow-hidden"
      >
        <div className="px-8 pt-6 pb-2 min-h-[360px] space-y-4">
          {step === 'welcome' && (
            <>
              <div className="flex items-center gap-2 text-accent">
                <Icon.Users size={18} />
                <p className="text-[10px] uppercase tracking-[0.18em] font-semibold">Family controls — beta</p>
              </div>
              <h2 className="text-xl font-medium text-text">Lock apps on a child's computer from your own</h2>
              <p className="text-sm text-muted leading-relaxed">
                You sign in on your machine. The child's machine pairs with your account. From then on,
                you can block specific apps and websites on the child's computer at any time, from anywhere.
              </p>
              <div className="space-y-2 text-xs text-muted pt-1">
                <div className="flex items-start gap-2">
                  <Icon.ShieldChk size={14} className="text-success shrink-0 mt-0.5" />
                  <p><span className="text-text">What it stops:</span> casual bypass attempts — killing the daemon, editing the hosts file, rebooting into safe mode.</p>
                </div>
                <div className="flex items-start gap-2">
                  <Icon.Warning size={14} className="text-warn shrink-0 mt-0.5" />
                  <p><span className="text-text">What it doesn't:</span> a kid with administrator rights, a USB Linux boot, or BIOS access. Honest about the limits.</p>
                </div>
                <div className="flex items-start gap-2">
                  <Icon.Lock size={14} className="text-muted shrink-0 mt-0.5" />
                  <p><span className="text-text">The single load-bearing thing:</span> the child's OS account must NOT be an administrator. Everything else assumes that.</p>
                </div>
              </div>
            </>
          )}

          {step === 'role' && (
            <>
              <h2 className="text-xl font-medium text-text">Which device is this?</h2>
              <p className="text-sm text-muted">Are you the parent setting things up, or is this the kid's computer being paired?</p>
              <div className="space-y-2 pt-2">
                <RoleCard
                  onClick={() => chooseRole('parent')}
                  title="I'm the parent"
                  body="This is my computer. I'll create the account and generate a pairing code for the kid's machine."
                  icon={<Icon.Profile size={20} className="text-accent" />}
                />
                <RoleCard
                  onClick={() => chooseRole('child')}
                  title="This is the child's computer"
                  body="I have a 6-digit pairing code from the parent's dashboard. Let me enter it."
                  icon={<Icon.Handshake size={20} className="text-accent" />}
                />
              </div>
            </>
          )}

          {step === 'parent-plan' && (
            <>
              <h2 className="text-xl font-medium text-text">Parent setup checklist</h2>
              <p className="text-sm text-muted">Here's what you'll do over the next few minutes:</p>
              <ol className="space-y-3 pt-2 list-none">
                <PlanItem n={1} title="Create your FocusLock family account">
                  Email + password. The same account works across all child devices you pair later.
                </PlanItem>
                <PlanItem n={2} title="Generate a 6-digit pairing code">
                  You'll see it on this dashboard. Codes expire after a few minutes — generate one when you're ready to walk to the kid's machine.
                </PlanItem>
                <PlanItem n={3} title="Pair the child's computer">
                  Open FocusLock on the kid's machine, go to Family, click "I have a pairing code", type the 6 digits.
                </PlanItem>
                <PlanItem n={4} title="Lock down the kid's OS account">
                  <span className="text-warn">The most important step.</span> Demote it to a standard (non-admin) account.
                  Without that, the kid can bypass everything in seconds.
                </PlanItem>
                <PlanItem n={5} title="Set rules from this dashboard">
                  Block apps and sites on the kid's device any time. Or hit Emergency unblock when something goes wrong.
                </PlanItem>
              </ol>
            </>
          )}

          {step === 'child-plan' && (
            <>
              <h2 className="text-xl font-medium text-text">Pairing this computer</h2>
              <p className="text-sm text-muted">Quick. Here's what happens:</p>
              <ol className="space-y-3 pt-2 list-none">
                <PlanItem n={1} title="Enter the 6-digit code">
                  Ask the parent for their current pairing code. Codes expire fast — get a fresh one if it doesn't work.
                </PlanItem>
                <PlanItem n={2} title="This device is now linked">
                  The parent's account can lock specific apps and websites on this machine at any time, from their own computer.
                </PlanItem>
                <PlanItem n={3} title="Local FocusLock keeps working">
                  Your own focus sessions still work normally. Family locks just stack on top — both you and the parent can block things.
                </PlanItem>
                <PlanItem n={4} title="You can unpair later">
                  This page has an Unpair button. If a settings-lock PIN is set, you'll need that PIN to unpair.
                </PlanItem>
              </ol>
              <p className="text-[11px] text-faint pt-2">
                When you close this, we'll jump you straight to the pairing-code field.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface2/40">
          <button onClick={onDone} className="btn-ghost px-3 py-1.5 text-xs text-faint hover:text-text">
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step !== 'welcome' && step !== 'role' && (
              <button onClick={() => setStep('role')} className="btn-ghost px-3 py-1.5 text-sm">
                Back
              </button>
            )}
            {step === 'welcome' && (
              <button onClick={() => setStep('role')} className="btn-primary px-4 py-2 text-sm">
                Continue
              </button>
            )}
            {(step === 'parent-plan' || step === 'child-plan') && (
              <button onClick={finish} className="btn-primary px-4 py-2 text-sm">
                Got it — let's go
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function RoleCard({ onClick, title, body, icon }: {
  onClick: () => void; title: string; body: string; icon: React.ReactNode;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className="w-full text-left card p-4 hover:border-accent/40 hover:bg-accent/5 transition-colors flex items-start gap-3"
    >
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div>
        <p className="text-sm font-medium text-text mb-0.5">{title}</p>
        <p className="text-xs text-muted">{body}</p>
      </div>
    </button>
  );
}

function PlanItem({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <div className={cn(
        'shrink-0 w-6 h-6 rounded-full bg-accent/15 text-accent text-xs font-medium flex items-center justify-center',
      )}>{n}</div>
      <div className="text-xs text-muted leading-relaxed">
        <p className="text-sm text-text font-medium mb-0.5">{title}</p>
        {children}
      </div>
    </li>
  );
}
