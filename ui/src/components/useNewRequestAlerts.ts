import { useEffect, useRef } from 'react';
import { useFamily } from '../stores/family';

const SEEN_KEY = 'focus-lock:approval-request-last-seen';
const ENABLED_KEY = 'focus-lock:approval-request-notify-enabled';

function isEnabled(): boolean {
  const raw = localStorage.getItem(ENABLED_KEY);
  return raw === null ? true : raw === '1';
}

/// Watches the Family Inbox for new `approval_request` notifications and
/// fires a desktop notification on the FIRST sight of each one. Idempotent
/// across reloads via a localStorage seen-marker keyed on the newest
/// notification id we've alerted on.
export function useNewRequestAlerts(active: boolean): void {
  const notifications = useFamily(s => s.notifications);
  const requestsById  = useFamily(s => s.requestsById);
  const seenRef = useRef<number>(0);

  useEffect(() => {
    const raw = localStorage.getItem(SEEN_KEY);
    seenRef.current = raw ? Number(raw) || 0 : 0;
  }, []);

  useEffect(() => {
    if (!active || !isEnabled()) return;
    if (notifications.length === 0) return;

    let highest = seenRef.current;
    for (const n of notifications) {
      if (n.kind !== 'approval_request') continue;
      if (n.id <= seenRef.current) continue;
      const reqId = (n.payload as { requestId?: string } | null)?.requestId;
      const req = reqId ? requestsById[reqId] : undefined;
      if (!req || req.status !== 'pending') continue;

      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body, silent: false }); }
        catch { /* ignore */ }
      }
      if (n.id > highest) highest = n.id;
    }
    if (highest > seenRef.current) {
      seenRef.current = highest;
      localStorage.setItem(SEEN_KEY, String(highest));
    }
  }, [active, notifications, requestsById]);
}

/// Toggle for the Settings page. Stored in localStorage; defaults to "on".
export function setApprovalRequestNotificationsEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
}
export function getApprovalRequestNotificationsEnabled(): boolean {
  return isEnabled();
}
