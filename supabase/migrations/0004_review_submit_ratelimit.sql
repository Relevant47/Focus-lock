-- 0004_review_submit_ratelimit — per-IP rate-limit table for landing-page
-- review submissions (api/submit-review.js). Mirrors the survey_submit_ratelimit
-- pattern from 0001 so we can throttle anonymous review POSTs without storing
-- raw IPs alongside the public `reviews` rows.
--
-- Apply to project ipmmmebtsbhplcmwkflh via the Supabase MCP or:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0004_review_submit_ratelimit.sql

create table if not exists public.review_submit_ratelimit (
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists review_submit_ratelimit_idx
  on public.review_submit_ratelimit (ip_hash, created_at desc);

-- RLS: deny-by-default. All access is via the Vercel function using the
-- service role key (which bypasses RLS). No anon/authenticated policies.
alter table public.review_submit_ratelimit enable row level security;

-- Same grant rationale as survey_submit_ratelimit in 0001: tables created via
-- raw SQL run as `postgres`, which in this project does not inherit Supabase's
-- default DML grants for service_role. Without these grants the Vercel function
-- (which authenticates as service_role) would 500 on insert.
grant select, insert, update, delete on public.review_submit_ratelimit to service_role;
