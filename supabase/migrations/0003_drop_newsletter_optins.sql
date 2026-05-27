-- 0003_drop_newsletter_optins — the in-app survey newsletter moved to a Beehiiv
-- inline embed (landing/newsletter-embed.html), which sends signups straight to
-- Beehiiv. We no longer record opt-ins ourselves, so drop the now-unused table and
-- rewrite refresh_survey_stats() to stop referencing it (otherwise the nightly cron
-- would error on the missing relation). Newsletter numbers now live in the Beehiiv
-- dashboard. Applied to project ipmmmebtsbhplcmwkflh via the Supabase MCP.

create or replace function public.refresh_survey_stats()
returns void language sql security definer set search_path = public as $$
  insert into public.survey_stats_daily (snapshot_date, computed_at, metrics)
  values (current_date, now(), jsonb_build_object(
    'total_responses',       (select count(*) from survey_responses),
    'completed_responses',   (select count(*) from survey_responses where completed_at is not null),
    'prompts_shown',         (select count(*) from survey_prompts_shown where event='shown'),
    'prompts_completed',     (select count(*) from survey_prompts_shown where event='completed'),
    'avg_nps',               (select round(avg(nps)::numeric,2) from survey_responses where nps is not null),
    'age_range',          (select coalesce(jsonb_object_agg(age_range,c),'{}') from (select age_range::text,count(*) c from survey_responses where age_range is not null group by 1) t),
    'profession',         (select coalesce(jsonb_object_agg(profession,c),'{}') from (select profession::text,count(*) c from survey_responses where profession is not null group by 1) t),
    'heard_about',        (select coalesce(jsonb_object_agg(heard_about,c),'{}') from (select heard_about::text,count(*) c from survey_responses where heard_about is not null group by 1) t),
    'primary_os',         (select coalesce(jsonb_object_agg(primary_os,c),'{}') from (select primary_os::text,count(*) c from survey_responses where primary_os is not null group by 1) t),
    'usage_frequency',    (select coalesce(jsonb_object_agg(usage_frequency,c),'{}') from (select usage_frequency::text,count(*) c from survey_responses where usage_frequency is not null group by 1) t),
    'main_reason',        (select coalesce(jsonb_object_agg(main_reason,c),'{}') from (select main_reason::text,count(*) c from survey_responses where main_reason is not null group by 1) t),
    'bypassed',           (select coalesce(jsonb_object_agg(bypassed,c),'{}') from (select bypassed::text,count(*) c from survey_responses where bypassed is not null group by 1) t),
    'tried_apps',         (select coalesce(jsonb_object_agg(app,c),'{}')  from (select unnest(tried_apps) app,count(*) c from survey_responses group by 1) t),
    'wanted_features',    (select coalesce(jsonb_object_agg(feat,c),'{}') from (select unnest(wanted_features) feat,count(*) c from survey_responses group by 1) t),
    'blocked_categories', (select coalesce(jsonb_object_agg(cat,c),'{}')  from (select unnest(blocked_categories) cat,count(*) c from survey_responses group by 1) t),
    'nps_distribution',   (select coalesce(jsonb_object_agg(nps::text,c),'{}') from (select nps,count(*) c from survey_responses where nps is not null group by 1) t),
    'country_top',        (select coalesce(jsonb_object_agg(country,c),'{}') from (select country,count(*) c from survey_responses where country is not null group by 1 order by c desc limit 20) t)
  ))
  on conflict (snapshot_date) do update set metrics = excluded.metrics, computed_at = excluded.computed_at;
$$;

drop table if exists public.newsletter_optins;
drop type if exists newsletter_status;
