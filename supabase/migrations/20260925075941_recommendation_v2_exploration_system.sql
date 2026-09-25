-- Recommendation V2 telemetry and bounded, RLS-aware candidate retrieval.

create table if not exists public.place_impressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  session_id uuid,
  request_id uuid,
  position integer not null check (position > 0),
  source text not null check (source in ('collaborative', 'content', 'nearby', 'trending', 'exploration', 'search', 'similar')),
  recommendation_score double precision check (recommendation_score between 0 and 1),
  exploration boolean not null default false,
  created_at timestamptz not null default now(),
  check (user_id is not null or session_id is not null)
);

create index if not exists place_impressions_user_place_idx
  on public.place_impressions(user_id, place_id);
create index if not exists place_impressions_user_created_idx
  on public.place_impressions(user_id, created_at desc);
create index if not exists place_impressions_place_created_idx
  on public.place_impressions(place_id, created_at desc);
create index if not exists place_impressions_session_created_idx
  on public.place_impressions(session_id, created_at desc)
  where user_id is null;
create unique index if not exists place_impressions_request_place_user_idx
  on public.place_impressions(user_id, request_id, place_id)
  where user_id is not null and request_id is not null;
create unique index if not exists place_impressions_request_place_session_idx
  on public.place_impressions(session_id, request_id, place_id)
  where user_id is null and request_id is not null;

create table if not exists public.place_recommendation_stats (
  place_id uuid primary key references public.places(id) on delete cascade,
  impressions bigint not null default 0 check (impressions >= 0),
  detail_views bigint not null default 0 check (detail_views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  saves bigint not null default 0 check (saves >= 0),
  shares bigint not null default 0 check (shares >= 0),
  hides bigint not null default 0 check (hides >= 0),
  weighted_reward double precision not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_place_recommendation_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  impression_count integer not null default 0 check (impression_count >= 0),
  detail_view_count integer not null default 0 check (detail_view_count >= 0),
  like_count integer not null default 0 check (like_count >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  hide_count integer not null default 0 check (hide_count >= 0),
  is_hidden boolean not null default false,
  last_impression_at timestamptz,
  last_interaction_at timestamptz,
  primary key (user_id, place_id)
);

create index if not exists user_place_rec_last_seen_idx
  on public.user_place_recommendation_state(user_id, last_impression_at desc);
create index if not exists user_place_rec_hidden_idx
  on public.user_place_recommendation_state(user_id, is_hidden, last_impression_at desc);

create table if not exists public.place_recommendation_events (
  id uuid primary key default gen_random_uuid(),
  client_event_id uuid,
  user_id uuid references auth.users(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  session_id uuid,
  request_id uuid,
  position integer check (position > 0),
  source text not null check (source in ('collaborative', 'content', 'nearby', 'trending', 'exploration', 'search', 'similar')),
  event_type text not null check (event_type in ('detail_open', 'long_detail_view', 'like', 'save', 'share', 'hide')),
  reward smallint not null check (reward in (1, 2, 3, 4, -5)),
  created_at timestamptz not null default now(),
  check (user_id is not null or session_id is not null)
);

create unique index if not exists place_recommendation_events_client_id_idx
  on public.place_recommendation_events(user_id, client_event_id)
  where user_id is not null and client_event_id is not null;
create index if not exists place_recommendation_events_place_created_idx
  on public.place_recommendation_events(place_id, created_at desc);
create index if not exists place_recommendation_events_user_created_idx
  on public.place_recommendation_events(user_id, created_at desc);

alter table public.place_impressions enable row level security;
alter table public.place_recommendation_stats enable row level security;
alter table public.user_place_recommendation_state enable row level security;
alter table public.place_recommendation_events enable row level security;

grant select, insert on public.place_impressions to authenticated;
grant insert on public.place_impressions to anon;
grant select, insert on public.place_recommendation_events to authenticated;
grant insert on public.place_recommendation_events to anon;
grant select on public.user_place_recommendation_state to authenticated;
grant select on public.user_place_recommendation_state to anon;
grant select on public.place_recommendation_stats to anon, authenticated;

drop policy if exists place_impressions_read_own on public.place_impressions;
create policy place_impressions_read_own on public.place_impressions
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists place_impressions_insert_visible on public.place_impressions;
create policy place_impressions_insert_visible on public.place_impressions
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.places p where p.id = place_id and p.is_public and public.can_view_place(p.id))
  );
drop policy if exists place_impressions_insert_anon_visible on public.place_impressions;
create policy place_impressions_insert_anon_visible on public.place_impressions
  for insert to anon with check (
    user_id is null and session_id is not null
    and exists (select 1 from public.places p where p.id = place_id and p.is_public and public.can_view_place(p.id))
  );

drop policy if exists place_rec_stats_read_visible on public.place_recommendation_stats;
create policy place_rec_stats_read_visible on public.place_recommendation_stats
  for select to anon, authenticated using (
    exists (select 1 from public.places p where p.id = place_id and p.is_public and public.can_view_place(p.id))
  );

drop policy if exists user_place_rec_state_read_own on public.user_place_recommendation_state;
create policy user_place_rec_state_read_own on public.user_place_recommendation_state
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists user_place_rec_state_read_anon_none on public.user_place_recommendation_state;
create policy user_place_rec_state_read_anon_none on public.user_place_recommendation_state
  for select to anon using (false);

drop policy if exists place_rec_events_read_own on public.place_recommendation_events;
create policy place_rec_events_read_own on public.place_recommendation_events
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists place_rec_events_insert_visible on public.place_recommendation_events;
create policy place_rec_events_insert_visible on public.place_recommendation_events
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.places p where p.id = place_id and p.is_public and public.can_view_place(p.id))
  );
drop policy if exists place_rec_events_insert_anon_visible on public.place_recommendation_events;
create policy place_rec_events_insert_anon_visible on public.place_recommendation_events
  for insert to anon with check (
    user_id is null and session_id is not null
    and exists (select 1 from public.places p where p.id = place_id and p.is_public and public.can_view_place(p.id))
  );

create or replace function public.apply_place_recommendation_impression()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.place_recommendation_stats (place_id, impressions, updated_at)
  values (new.place_id, 1, now())
  on conflict (place_id) do update set
    impressions = public.place_recommendation_stats.impressions + 1,
    updated_at = excluded.updated_at;

  if new.user_id is not null then
    insert into public.user_place_recommendation_state (
      user_id, place_id, impression_count, last_impression_at
    ) values (new.user_id, new.place_id, 1, new.created_at)
    on conflict (user_id, place_id) do update set
      impression_count = public.user_place_recommendation_state.impression_count + 1,
      last_impression_at = greatest(public.user_place_recommendation_state.last_impression_at, excluded.last_impression_at);
  end if;
  return new;
end;
$$;
revoke all on function public.apply_place_recommendation_impression() from public, anon, authenticated;

create trigger place_impressions_update_recommendation_state
  after insert on public.place_impressions
  for each row execute function public.apply_place_recommendation_impression();

create or replace function public.apply_place_recommendation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.place_recommendation_stats (place_id, updated_at)
  values (new.place_id, now()) on conflict (place_id) do nothing;
  update public.place_recommendation_stats s set
    detail_views = s.detail_views + case when new.event_type in ('detail_open', 'long_detail_view') then 1 else 0 end,
    likes = s.likes + case when new.event_type = 'like' then 1 else 0 end,
    saves = s.saves + case when new.event_type = 'save' then 1 else 0 end,
    shares = s.shares + case when new.event_type = 'share' then 1 else 0 end,
    hides = s.hides + case when new.event_type = 'hide' then 1 else 0 end,
    weighted_reward = s.weighted_reward + new.reward,
    updated_at = now()
  where s.place_id = new.place_id;

  if new.user_id is not null then
    insert into public.user_place_recommendation_state (user_id, place_id, last_interaction_at)
    values (new.user_id, new.place_id, new.created_at)
    on conflict (user_id, place_id) do update set
      detail_view_count = public.user_place_recommendation_state.detail_view_count + case when new.event_type in ('detail_open', 'long_detail_view') then 1 else 0 end,
      like_count = public.user_place_recommendation_state.like_count + case when new.event_type = 'like' then 1 else 0 end,
      save_count = public.user_place_recommendation_state.save_count + case when new.event_type = 'save' then 1 else 0 end,
      hide_count = public.user_place_recommendation_state.hide_count + case when new.event_type = 'hide' then 1 else 0 end,
      is_hidden = public.user_place_recommendation_state.is_hidden or new.event_type = 'hide',
      last_interaction_at = excluded.last_interaction_at;
  end if;
  return new;
end;
$$;
revoke all on function public.apply_place_recommendation_event() from public, anon, authenticated;

create trigger place_recommendation_events_update_stats
  after insert on public.place_recommendation_events
  for each row execute function public.apply_place_recommendation_event();

create or replace function public.record_recommendation_impressions(
  p_request_id uuid,
  p_session_id uuid,
  p_impressions jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  if jsonb_typeof(p_impressions) <> 'array' or jsonb_array_length(p_impressions) < 1 or jsonb_array_length(p_impressions) > 50 then
    raise exception 'Expected 1 to 50 impressions';
  end if;
  if v_user_id is null and p_session_id is null then
    raise exception 'Session id required for anonymous impressions';
  end if;
  insert into public.place_impressions (
    user_id, place_id, session_id, request_id, position, source, recommendation_score, exploration
  )
  select v_user_id, x.place_id, p_session_id, p_request_id, x.position, x.source, x.score, x.source = 'exploration'
  from jsonb_to_recordset(p_impressions) as x(place_id uuid, position integer, source text, score double precision)
  where x.place_id is not null and x.position between 1 and 1000
    and x.source in ('collaborative', 'content', 'nearby', 'trending', 'exploration', 'search', 'similar')
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.record_recommendation_impressions(uuid, uuid, jsonb) from public;
grant execute on function public.record_recommendation_impressions(uuid, uuid, jsonb) to anon, authenticated;

create or replace function public.record_recommendation_events(
  p_session_id uuid,
  p_events jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  if v_user_id is null and p_session_id is null then
    raise exception 'Session id required for anonymous events';
  end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) < 1 or jsonb_array_length(p_events) > 50 then
    raise exception 'Expected 1 to 50 events';
  end if;
  insert into public.place_recommendation_events (
    client_event_id, user_id, place_id, session_id, request_id, position, source, event_type, reward
  )
  select x.client_event_id, v_user_id, x.place_id, p_session_id, x.request_id, x.position, x.source, x.event_type,
    case x.event_type when 'detail_open' then 1 when 'long_detail_view' then 2 when 'like' then 3 when 'save' then 4 when 'share' then 4 when 'hide' then -5 end
  from jsonb_to_recordset(p_events) as x(client_event_id uuid, place_id uuid, request_id uuid, position integer, source text, event_type text)
  where x.place_id is not null
    and x.event_type in ('detail_open', 'long_detail_view', 'like', 'save', 'share', 'hide')
    and x.source in ('collaborative', 'content', 'nearby', 'trending', 'exploration', 'search', 'similar')
  on conflict (user_id, client_event_id) where user_id is not null and client_event_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.record_recommendation_events(uuid, jsonb) from public;
grant execute on function public.record_recommendation_events(uuid, jsonb) to anon, authenticated;

create or replace function public.get_recommendation_candidates(
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_radius_km double precision default null,
  p_categories text[] default null,
  p_preferred_categories text[] default null,
  p_provinces text[] default null,
  p_countries text[] default null,
  p_limit integer default 100,
  p_excluded_place_ids uuid[] default '{}',
  p_require_unseen boolean default false
)
returns table (
  id uuid, user_id uuid, title text, description text, province text, country text, category text,
  latitude double precision, longitude double precision, address text, is_public boolean,
  is_premium_only boolean, created_at timestamptz, updated_at timestamptz,
  like_count bigint, comment_count bigint, impression_count integer, last_impression_at timestamptz,
  quality_score double precision, popularity_score double precision, distance_km double precision,
  has_image boolean, metadata_completeness double precision, is_hidden boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 300 then raise exception 'Invalid candidate limit'; end if;
  if (p_latitude is null) <> (p_longitude is null) then raise exception 'Latitude and longitude must be supplied together'; end if;
  if p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude not between -180 and 180) then raise exception 'Invalid coordinates'; end if;
  if p_radius_km is not null and (p_radius_km < 1 or p_radius_km > 200) then raise exception 'Invalid radius'; end if;

  return query
  with candidate_rows as (
    select
      v.id, p.user_id, v.title, v.description, v.province, v.country, v.category::text as category,
      v.latitude, v.longitude, v.address, v.is_public, v.is_premium_only, v.created_at, v.updated_at,
      v.like_count, v.comment_count,
      coalesce(state.impression_count, 0) as impression_count,
      state.last_impression_at,
      coalesce(state.is_hidden, false) as is_hidden,
      exists (select 1 from public.place_images img where img.place_id = p.id) as has_image,
      least(1::double precision, (
        (case when length(coalesce(trim(v.title), '')) > 0 then 1 else 0 end)
        + (case when length(coalesce(trim(v.description), '')) >= 80 then 1 else 0 end)
        + (case when v.category is not null then 1 else 0 end)
        + (case when v.province is not null or v.country is not null then 1 else 0 end)
        + (case when v.latitude is not null and v.longitude is not null then 1 else 0 end)
      ) / 5.0) as metadata_completeness,
      case when p_latitude is null or p.location is null then null::double precision
        else extensions.st_distance(p.location, extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography) / 1000.0
      end as distance_km,
      coalesce(stats.impressions, 0) as total_impressions,
      coalesce(stats.likes, 0) as total_likes,
      coalesce(stats.weighted_reward, 0) as weighted_reward,
      coalesce((v.category::text = any(coalesce(p_preferred_categories, '{}')))::integer, 0) as category_match,
      coalesce((v.province = any(coalesce(p_provinces, '{}')) or v.country = any(coalesce(p_countries, '{}')))::integer, 0) as region_match
    from public.places_with_counts v
    join public.places p on p.id = v.id
    left join public.user_place_recommendation_state state
      on state.user_id = auth.uid() and state.place_id = p.id
    left join public.place_recommendation_stats stats on stats.place_id = p.id
    where v.is_public
      and not (v.id = any(coalesce(p_excluded_place_ids, '{}')))
      and (coalesce(cardinality(p_categories), 0) = 0 or v.category::text = any(p_categories))
      and (p_radius_km is null or p.location is null or extensions.st_dwithin(
        p.location,
        extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography,
        p_radius_km * 1000
      ))
      and (p_require_unseen = false or (coalesce(state.impression_count, 0) = 0 and state.last_impression_at is null))
      and coalesce(state.is_hidden, false) = false
  ), scored as (
    select c.*,
      0.4 * c.has_image::integer
        + 0.3 * c.metadata_completeness
        + 0.3 * greatest(0::double precision, least(1::double precision, c.weighted_reward / greatest(c.total_impressions, 1) / 4.0)) as quality_score,
      least(1::double precision, ln(1 + greatest(c.total_likes, c.like_count)) / ln(101.0)) as popularity_score
    from candidate_rows c
  )
  select s.id, s.user_id, s.title, s.description, s.province, s.country, s.category,
    s.latitude, s.longitude, s.address, s.is_public, s.is_premium_only, s.created_at, s.updated_at,
    s.like_count, s.comment_count, s.impression_count, s.last_impression_at,
    s.quality_score, s.popularity_score, s.distance_km, s.has_image, s.metadata_completeness, s.is_hidden
  from scored s
  order by
    case when p_require_unseen then
      0.30 * (s.category_match + s.region_match)::double precision
      + 0.25 * coalesce(1 - least(1::double precision, s.distance_km / 30.0), 0)
      + 0.20 * s.quality_score
      + 0.15 * exp(-greatest(0, extract(epoch from (now() - s.created_at)) / 86400.0) / 180.0)
      + 0.10 * s.popularity_score
      else
      0.35 * (s.category_match + s.region_match)::double precision
      + 0.20 * coalesce(1 - least(1::double precision, s.distance_km / 30.0), 0)
      + 0.20 * s.quality_score
      + 0.15 * exp(-greatest(0, extract(epoch from (now() - s.created_at)) / 86400.0) / 180.0)
      + 0.10 * s.popularity_score
    end desc,
    s.impression_count asc, s.created_at desc, s.id asc
  limit p_limit;
end;
$$;

revoke all on function public.get_recommendation_candidates(double precision, double precision, double precision, text[], text[], text[], text[], integer, uuid[], boolean) from public;
grant execute on function public.get_recommendation_candidates(double precision, double precision, double precision, text[], text[], text[], text[], integer, uuid[], boolean) to anon, authenticated;
