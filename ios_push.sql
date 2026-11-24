-- Run in Supabase SQL Editor to enable Web Push subscriptions.

create table if not exists public.push_subscriptions (
  endpoint text primary key check (endpoint like 'https://%'),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

drop policy if exists "Users manage their push subscriptions" on public.push_subscriptions;
create policy "Users manage their push subscriptions"
  on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create table if not exists public.push_notification_events (
  event_key text primary key,
  created_at timestamptz not null default now()
);

alter table public.push_notification_events enable row level security;
revoke all on public.push_notification_events from public, anon, authenticated;
grant all on public.push_notification_events to service_role;
create index if not exists push_notification_events_created_at_idx
  on public.push_notification_events(created_at);
