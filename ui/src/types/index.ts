export type {
  PomodoroConfig,
  SessionState,
  FocusProfile,
  BlockCategory,
  ScheduledSession,
  SessionLog,
  StartSessionPayload,
  StopSessionPayload,
  DaemonStatus,
  ParentAuditEntry,
  ParentAuditEventType,
  FamilyStatus,
  FamilyEnvironment,
  FamilyRuleSummary,
  FamilyRedeemPayload,
  FamilyRedeemResult,
  LocalUserAccount,
  UsageRetentionDays,
  UsageReportSamplePayload,
  UsageQueryPayload,
  UsageQueryRow,
  UsageQueryResult,
  UsageSetSettingsPayload,
  UsageGetSettingsResult,
} from '@shared/protocol';

export { CATEGORY_DOMAINS } from '@shared/protocol';

export const CATEGORY_LABELS: Record<string, string> = {
  social_media: 'Social Media',
  streaming: 'Streaming & Video',
  gaming: 'Gaming',
  news: 'News & Media',
  adult: 'Adult Content',
};
