-- Feed Miou: push notifications when someone feeds the cat and when a meal is late.
--
-- The phones seal every notification text with the coloc key, like the documents, so the server
-- only stores ciphertext. What it does see: when to check (meal time + 45 min) and which feed
-- paths to look for, which were already readable in feedmiou_docs.
--
-- Flow: a phone queues an alert (feedmiou_alert_fed right after a feed, feedmiou_alarms_sync for the
-- next two weeks of meals). Every 30 s, pg_cron calls feedmiou_push_tick(), which pokes the
-- feedmiou-push edge function only when an alert is due. The function claims the due alerts
-- (feedmiou_push_claim decides which ones still apply) and sends them with Web Push.
-- The VAPID key pair lives in Vault under the name feedmiou_vapid:
--   {"publicKey": "...", "privateKey": "...", "subject": "https://..."}
-- The edge function makes it on its first call (feedmiou_vapid_init), so the private key never
-- leaves the server; the public key is copied into index.html.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table public.feedmiou_push_subs (
  endpoint text primary key check (length(endpoint) <= 1000 and endpoint ~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)/'),
  p256dh text not null check (length(p256dh) between 80 and 100),
  auth text not null check (length(auth) between 16 and 32),
  feeder text not null default '' check (length(feeder) <= 64),
  fed boolean not null default true,
  late boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.feedmiou_alerts (
  id text primary key,
  kind text not null check (kind in ('fed', 'late')),
  send_at timestamptz not null,
  paths text[] not null,
  skip_feeder text not null default '',
  payload jsonb not null,
  sent_at timestamptz
);
create index feedmiou_alerts_due on public.feedmiou_alerts (send_at) where sent_at is null;

-- no policies: phones only go through the functions below, which check the coloc code
alter table public.feedmiou_push_subs enable row level security;
alter table public.feedmiou_alerts enable row level security;
revoke all on table public.feedmiou_push_subs, public.feedmiou_alerts from anon, authenticated;

create or replace function public.feedmiou_paths_ok(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p) between 1 and 20, false)
    and not exists (select 1 from unnest(p) x where x is null or x !~ '^feeds/[0-9]{4}-[0-9]{2}-[0-9]{2}_[A-Za-z0-9_-]{1,40}$')
$$;

create or replace function public.feedmiou_payload_ok(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object' and jsonb_typeof(p->'e') = 'string' and length(p::text) <= 3000, false)
$$;

-- one row per phone; feeder is the profile id, to spare people their own "fed" notifications
create or replace function public.feedmiou_push_save(p_endpoint text, p_p256dh text, p_auth text, p_feeder text, p_fed boolean, p_late boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.feedmiou_ok() then return false; end if;
  insert into public.feedmiou_push_subs (endpoint, p256dh, auth, feeder, fed, late)
  values (p_endpoint, p_p256dh, p_auth, coalesce(p_feeder, ''), coalesce(p_fed, true), coalesce(p_late, true))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, feeder = excluded.feeder,
    fed = excluded.fed, late = excluded.late, updated_at = now();
  return true;
end $$;

create or replace function public.feedmiou_push_remove(p_endpoint text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.feedmiou_ok() then return false; end if;
  delete from public.feedmiou_push_subs where endpoint = p_endpoint;
  return true;
end $$;

-- sent a few seconds later, and only if the portions are still marked as given (the toast offers an undo)
create or replace function public.feedmiou_alert_fed(p_id text, p_paths text[], p_skip text, p_payload jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.feedmiou_ok() then return false; end if;
  if coalesce(p_id, '') !~ '^fed_[A-Za-z0-9]{1,40}$' or not public.feedmiou_paths_ok(p_paths)
     or length(coalesce(p_skip, '')) > 64 or not public.feedmiou_payload_ok(p_payload) then
    raise exception 'invalid alert' using errcode = '22023';
  end if;
  insert into public.feedmiou_alerts (id, kind, send_at, paths, skip_feeder, payload)
  values (p_id, 'fed', now() + interval '8 seconds', array(select distinct unnest(p_paths)), coalesce(p_skip, ''), p_payload)
  on conflict (id) do nothing;
  return true;
end $$;

-- p_alarms: [{ id: "late_2026-10-26_soir", at: <ms since epoch>, paths: ["feeds/…"], payload: {v, e} }]
-- Replaces every pending "late" alarm: the phones send the whole upcoming list each time the plan changes.
create or replace function public.feedmiou_alarms_sync(p_alarms jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.feedmiou_ok() then return false; end if;
  if jsonb_typeof(p_alarms) is distinct from 'array' or jsonb_array_length(p_alarms) > 200 or exists (
    select 1 from jsonb_array_elements(p_alarms) a
    where case when jsonb_typeof(a) <> 'object' then true
      else coalesce(a->>'id', '') !~ '^late_[0-9]{4}-[0-9]{2}-[0-9]{2}_[a-z]{1,10}$'
        or jsonb_typeof(a->'at') is distinct from 'number'
        or not public.feedmiou_payload_ok(a->'payload')
        or case when jsonb_typeof(a->'paths') = 'array'
             then not public.feedmiou_paths_ok(array(select jsonb_array_elements_text(a->'paths')))
             else true end
      end
  ) then
    raise exception 'invalid alarms' using errcode = '22023';
  end if;

  insert into public.feedmiou_alerts as t (id, kind, send_at, paths, payload)
  select distinct on (a->>'id') a->>'id', 'late', to_timestamp((a->>'at')::double precision / 1000),
    array(select distinct x from jsonb_array_elements_text(a->'paths') x), a->'payload'
  from jsonb_array_elements(p_alarms) a
  where to_timestamp((a->>'at')::double precision / 1000) > now()
  on conflict (id) do update set send_at = excluded.send_at, paths = excluded.paths, payload = excluded.payload
    where t.sent_at is null;

  delete from public.feedmiou_alerts t
  where t.kind = 'late' and t.sent_at is null and t.send_at > now()
    and not exists (select 1 from jsonb_array_elements(p_alarms) a where a->>'id' = t.id);
  return true;
end $$;

-- For the edge function (service role only). Marks the due alerts as handled and returns the ones
-- that still apply: a "fed" alert whose portions are all still there, a "late" alert whose meal
-- is still missing a portion. Stale ones (the cron was down) are dropped.
create or replace function public.feedmiou_push_claim()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  jobs jsonb;
begin
  delete from public.feedmiou_alerts where sent_at < now() - interval '2 days';

  with due as (
    update public.feedmiou_alerts a set sent_at = now()
    where a.id in (
      select id from public.feedmiou_alerts
      where sent_at is null and send_at <= now()
      order by send_at limit 50
      for update skip locked)
    returning a.*
  ), checked as (
    select d.*, cardinality(d.paths) as total,
      (select count(*) from public.feedmiou_docs f where f.path = any(d.paths))::int as given
    from due d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'left', c.total - c.given, 'total', c.total, 'payload', c.payload,
      'subs', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
               from public.feedmiou_push_subs s
               where case c.kind when 'fed' then s.fed and s.feeder <> c.skip_feeder else s.late end))), '[]'::jsonb)
  into jobs
  from checked c
  where (c.kind = 'fed' and c.given = c.total and c.send_at > now() - interval '1 hour')
     or (c.kind = 'late' and c.given < c.total and c.send_at > now() - interval '2 hours');

  return jsonb_build_object('jobs', jobs,
    'vapid', (select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'feedmiou_vapid' limit 1));
end $$;

create or replace function public.feedmiou_push_gone(p_endpoints text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.feedmiou_push_subs where endpoint = any(p_endpoints)
$$;

create or replace function public.feedmiou_vapid_init(p_vapid jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from vault.secrets where name = 'feedmiou_vapid') then
    perform vault.create_secret(p_vapid::text, 'feedmiou_vapid', 'Feed Miou : clés des notifications');
  end if;
  return (select decrypted_secret::jsonb from vault.decrypted_secrets where name = 'feedmiou_vapid' limit 1);
end $$;

create or replace function public.feedmiou_push_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.feedmiou_alerts where sent_at is null and send_at <= now()) then
    perform net.http_post(
      url := 'https://glmneumandikofewrzjy.supabase.co/functions/v1/feedmiou-push',
      body := '{}'::jsonb,
      timeout_milliseconds := 15000);
  end if;
end $$;

revoke all on function public.feedmiou_push_claim(), public.feedmiou_push_gone(text[]), public.feedmiou_vapid_init(jsonb), public.feedmiou_push_tick() from public, anon, authenticated;
grant execute on function public.feedmiou_push_claim(), public.feedmiou_push_gone(text[]), public.feedmiou_vapid_init(jsonb) to service_role;

select cron.schedule('feedmiou-push', '30 seconds', 'select public.feedmiou_push_tick()');
select cron.schedule('feedmiou-cron-cleanup', '23 4 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '2 days' and jobid in (select jobid from cron.job where jobname like 'feedmiou-%')$$);
