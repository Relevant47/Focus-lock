// Labels + visual tone for ParentAuditEntry events. Used by Settings and the
// Family page (parent dashboard) to render the audit log consistently.

type Tone = 'success' | 'warn' | 'danger' | 'neutral' | 'accent';

export const AUDIT_EVENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  pin_set:                  { label: 'PIN configured',         tone: 'success' },
  pin_changed:              { label: 'PIN changed',            tone: 'success' },
  pin_cleared:              { label: 'PIN removed',            tone: 'warn'    },
  pin_verify_success:       { label: 'Unlock — success',       tone: 'success' },
  pin_verify_fail:          { label: 'Unlock — wrong PIN',     tone: 'danger'  },
  pin_verify_rate_limited:  { label: 'Unlock — rate limited',  tone: 'warn'    },
  gate_blocked:             { label: 'Command blocked',        tone: 'danger'  },
  gate_allowed:             { label: 'Command allowed',        tone: 'neutral' },
  family_paired:            { label: 'Device paired',          tone: 'success' },
  family_unpaired:          { label: 'Device unpaired',        tone: 'warn'    },
  family_offline_5min:      { label: 'Offline > 5 min',        tone: 'warn'    },
  family_reconnected:       { label: 'Reconnected to server',  tone: 'success' },
  family_cache_tampered:    { label: 'Tamper detected',        tone: 'danger'  },
};

/// Wire-stable list of events that are family-specific (vs settings-lock /
/// general parental controls). Used to filter audit lists per dashboard.
export const FAMILY_AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'family_paired',
  'family_unpaired',
  'family_offline_5min',
  'family_reconnected',
  'family_cache_tampered',
]);

/// Events the user should be alerted about with an OS notification when they
/// first appear. The polling loop tracks the last-seen timestamp per process
/// so reload doesn't re-fire notifications for already-seen entries.
export const TAMPER_ALERT_EVENTS: ReadonlySet<string> = new Set([
  'family_cache_tampered',
  'family_offline_5min',
]);

export function formatAuditTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
