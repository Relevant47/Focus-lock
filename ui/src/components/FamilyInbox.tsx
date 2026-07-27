import { useEffect, useMemo, useState } from 'react';
import { useFamily } from '../stores/family';
import { Icon } from './Icons';
import { Pill } from './ui';
import { cn } from '../lib/cn';
import type { ApprovalRequest, Notification } from '../lib/familyApi';

const POLL_INTERVAL_MS = 60_000;

export default function FamilyInbox(): JSX.Element | null {
  const notifications  = useFamily(s => s.notifications);
  const unreadCount    = useFamily(s => s.unreadCount);
  const loadNotifs     = useFamily(s => s.loadNotifications);
  const markRead       = useFamily(s => s.markNotificationRead);
  const markAllRead    = useFamily(s => s.markAllNotificationsRead);
  const requestsById   = useFamily(s => s.requestsById);
  const hydrateRequest = useFamily(s => s.hydrateRequest);

  // Initial load + 60s poll while mounted. Same shape as the existing
  // devices poll in SignedInView — kept independent so a slow inbox call
  // never delays the device list.
  useEffect(() => {
    loadNotifs();
    const t = window.setInterval(loadNotifs, POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [loadNotifs]);

  // Hydrate every approval_request we see, if not cached. Cheap call — store
  // dedups by id, so re-running is a no-op for already-loaded rows.
  useEffect(() => {
    for (const n of notifications) {
      if (n.kind === 'approval_request') {
        const id = (n.payload as { requestId?: string } | null)?.requestId;
        if (id && !requestsById[id]) hydrateRequest(id);
      }
    }
  }, [notifications, requestsById, hydrateRequest]);

  // Inbox is purely additive — if there's nothing yet, don't take up screen
  // space. The page already has plenty going on.
  if (notifications.length === 0) return null;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Inbox</p>
          {unreadCount > 0 && <Pill tone="accent">{unreadCount} new</Pill>}
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead}
            className="text-xs text-muted hover:text-text">
            Mark all read
          </button>
        )}
      </div>

      <ul className="space-y-2">
        {notifications.map(n => {
          if (n.kind === 'approval_request') {
            const id = (n.payload as { requestId?: string } | null)?.requestId;
            const req = id ? requestsById[id] : undefined;
            return <ApprovalRequestCard key={n.id} notification={n}
              request={req}
              onMarkRead={() => markRead(n.id)} />;
          }
          return <NotificationCard key={n.id} notification={n} onMarkRead={() => markRead(n.id)} />;
        })}
      </ul>
    </div>
  );
}

function NotificationCard({ notification, onMarkRead }: {
  notification: Notification;
  onMarkRead: () => void;
}): JSX.Element {
  const isUnread = notification.readAt == null;
  const iconForKind = notification.kind === 'weekly_digest'
    ? <Icon.Chart size={14} />
    : <Icon.Users size={14} />;

  return (
    <li className={cn(
      'border rounded-md p-3 transition-colors',
      isUnread ? 'border-accent/30 bg-accent/5' : 'border-border/50',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text flex items-center gap-2">
            <span className={cn(isUnread ? 'text-accent' : 'text-dim')}>{iconForKind}</span>
            {notification.title}
            {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
          </p>
          <p className="text-xs text-muted mt-1 leading-relaxed">{notification.body}</p>
          <p className="text-[11px] text-faint mt-1.5 tnum">{relativeTime(notification.createdAt)}</p>
        </div>
        {isUnread && (
          <button onClick={onMarkRead}
            className="text-faint hover:text-text shrink-0"
            title="Mark read">
            <Icon.Check size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return 'in the future';
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ApprovalRequestCard({ notification, request, onMarkRead }: {
  notification: Notification;
  request: ApprovalRequest | undefined;
  onMarkRead: () => void;
}): JSX.Element {
  const approveRequest = useFamily(s => s.approveRequest);
  const denyRequest    = useFamily(s => s.denyRequest);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  const expiresAt = request?.expiresAt ?? null;
  const secondsLeft = useCountdown(expiresAt);
  const isPending = (request?.status ?? 'pending') === 'pending' && secondsLeft > 0;

  async function approve() {
    if (busy) return;
    setBusy('approve');
    try {
      await approveRequest(request!.id);
      onMarkRead();
    } catch (e) {
      // approveRequest re-throws non-409 errors so we can skip onMarkRead()
      // and leave the notification unread — the parent will see a stale card
      // instead of a silently-vanished one.
      console.warn('approve failed', e);
    } finally { setBusy(null); }
  }
  async function deny() {
    if (busy) return;
    setBusy('deny');
    try { await denyRequest(request!.id); onMarkRead(); }
    finally { setBusy(null); }
  }

  if (!request) {
    return (
      <li className="border rounded-md p-3 border-border/50">
        <p className="text-sm text-text">{notification.title}</p>
        <p className="text-xs text-faint mt-1">Loading…</p>
      </li>
    );
  }

  return (
    <li className={cn(
      'border rounded-md p-3 transition-colors',
      isPending ? 'border-accent/40 bg-accent/5' : 'border-border/50',
    )}>
      <p className="text-sm font-medium text-text">{notification.title}</p>
      <p className="text-xs text-muted mt-1 leading-relaxed">{notification.body}</p>
      {isPending && (
        <>
          <p className="text-[11px] text-faint mt-2 tnum">Expires in {fmtCountdown(secondsLeft)}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={approve} disabled={!!busy}
              className="btn-primary px-3 py-1.5 text-xs flex-1">
              {busy === 'approve' ? 'Working…' : 'Approve'}
            </button>
            <button onClick={deny} disabled={!!busy}
              className="btn-ghost px-3 py-1.5 text-xs flex-1">
              {busy === 'deny' ? 'Working…' : 'Deny'}
            </button>
          </div>
        </>
      )}
      {request.status === 'approved' && (
        <p className="text-xs text-success mt-2">✓ Approved · unblock active</p>
      )}
      {request.status === 'denied' && (
        <p className="text-xs text-faint mt-2">Denied</p>
      )}
      {request.status === 'expired' || (request.status === 'pending' && secondsLeft <= 0) ? (
        <p className="text-xs text-faint mt-2">Expired</p>
      ) : null}
    </li>
  );
}

function useCountdown(iso: string | null): number {
  const target = useMemo(() => iso ? Date.parse(iso) : 0, [iso]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.floor((target - now) / 1000)) : 0;
}

function fmtCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
