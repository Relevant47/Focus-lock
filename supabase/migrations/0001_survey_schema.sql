-- 0001_survey_schema — FocusLock in-app survey (additive; does not touch `reviews`).
-- Applied to project ipmmmebtsbhplcmwkflh via Supabase MCP. Single source of truth
-- for option values lives in shared/survey.ts — keep the enums below in lockstep.

-- Enums (single-select questions)
create type survey_age_range  as enum ('under_18','18_24','25_34','35_44','45_54','55_plus','prefer_not_to_say');
create type survey_profession as enum ('student','working_professional','freelancer','entrepreneur','researcher','other','prefer_not_to_say');
create type survey_heard_about as enum ('friend','social_media','youtube','reddit','google','product_hunt','blog','other','prefer_not_to_say');
create type survey_os         as enum ('windows','macos','linux','ios','android','multiple','prefer_not_to_say');
create type survey_frequency  as enum ('daily','several_times_week','weekly','occasionally','rarely','prefer_not_to_say');
create type survey_main_reason as enum ('work_focus','studying','reducing_social_media','beating_procrastination','digital_detox','other','prefer_not_to_say');
create type survey_bypassed   as enum ('yes','no','prefer_not_to_say');
create type survey_prompt_event as enum ('shown','dismissed','snoozed','started','abandoned','completed');
create type newsletter_status as enum ('pending','subscribed','failed');

create table public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  install_id text,
  user_id uuid,
  app_version text,
  os_detected text,
  age_range survey_age_range,
  profession survey_profession,
  country text,
  heard_about survey_heard_about,
  primary_os survey_os,
  usage_frequency survey_frequency,
  main_reason survey_main_reason,
  blocked_categories text[] not null default '{}',
  tried_apps text[] not null default '{}',
  tried_apps_other text,
  nps smallint check (nps between 0 and 10),
  like_most text check (char_length(like_most) <= 500),
  like_least text check (char_length(like_least) <= 500),
  wanted_features text[] not null default '{}',
  wanted_features_other text,
  bypassed survey_bypassed,
  bypass_method text check (char_length(bypass_method) <= 500)
);
create index survey_responses_created_at_idx on public.survey_responses (created_at desc);
create index survey_responses_install_id_idx on public.survey_responses (install_id);

create table public.survey_prompts_shown (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  install_id text,
  app_version text,
  event survey_prompt_event not null,
  step smallint
);
create index survey_prompts_shown_event_idx on public.survey_prompts_shown (event, created_at desc);

create table public.newsletter_optins (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text not null,
  consent boolean not null default false,
  install_id_hash text,
  source text not null default 'in-app-survey',
  beehiiv_status newsletter_status not null default 'pending',
  beehiiv_subscription_id text,
  retry_count integer not null default 0,
  last_error text,
  last_attempt_at timestamptz
);
create index newsletter_optins_status_idx on public.newsletter_optins (beehiiv_status, created_at);

create table public.survey_stats_daily (
  snapshot_date date primary key,
  computed_at timestamptz not null default now(),
  metrics jsonb not null
);

create table public.survey_submit_ratelimit (
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index survey_submit_ratelimit_idx on public.survey_submit_ratelimit (ip_hash, created_at desc);

-- RLS: deny-by-default. All access is via Vercel functions using the service role
-- key (which bypasses RLS). No anon/authenticated policies = no direct client access.
alter table public.survey_responses       enable row level security;
alter table public.survey_prompts_shown    enable row level security;
alter table public.newsletter_optins       enable row level security;
alter table public.survey_stats_daily      enable row level security;
alter table public.survey_submit_ratelimit enable row level security;

-- Grants: tables created via raw SQL / the Supabase MCP run as `postgres`, which in
-- this project does NOT inherit Supabase's default DML grants for service_role. Without
-- these grants the Vercel functions (which authenticate with the secret key → service_role)
-- get "permission denied" on insert and the API returns 500 — even though service_role
-- bypasses RLS. anon/authenticated are intentionally granted nothing (no direct client access).
grant select, insert, update, delete on
  public.survey_responses,
  public.survey_prompts_shown,
  public.newsletter_optins,
  public.survey_stats_daily,
  public.survey_submit_ratelimit
to service_role;
