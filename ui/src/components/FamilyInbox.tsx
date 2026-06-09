import { useEffect } from 'react';
import { useFamily } from '../stores/family';
import { Icon } from './Icons';
import { Pill } from './ui';
import { cn } from '../lib/cn';
import type { Notification } from '../lib/familyApi';

const POLL_INTERVAL_MS = 60_000;

export default function FamilyInbox(): JSX.Element | null {
  const notifications  = useFamily(s => s.notifications);
  const unreadCount    = useFamily(s => s.unreadCount);
  const loadNotifs     = useFamily(s => s.loadNotifications);
  const markRead       = useFamily(s => s.markNotificationRead);
  const markAllRead    = useFamily(s => s.markAllNotificationsRead);

  // Initial load + 60s poll while mounted. Same shape as the existing
  // devices poll in SignedInView — kept independent so a slow inbox call
  // never delays the device list.
  useEffect(() => {
    loadNotifs();
    const t = window.setInterval(loadNotifs, POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [loadNotifs]);

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
        {notifications.map(n => (
          <NotificationCard key={n.id} notification={n} onMarkRead={() => markRead(n.id)} />
        ))}
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
