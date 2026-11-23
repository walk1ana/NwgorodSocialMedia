-- NewGorod friend requests
-- Run once in Supabase SQL Editor after the initial migration.

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    constraint friend_requests_status check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_no_self check (sender_id <> recipient_id)
);

create index if not exists friend_requests_sender_idx
  on public.friend_requests(sender_id, status);
create index if not exists friend_requests_recipient_idx
  on public.friend_requests(recipient_id, status);

create unique index if not exists friend_requests_pending_pair_uidx
  on public.friend_requests (least(sender_id, recipient_id), greatest(sender_id, recipient_id))
  where status in ('pending', 'accepted');

alter table public.friend_requests enable row level security;

drop policy if exists "Friend requests are visible to participants" on public.friend_requests;
create policy "Friend requests are visible to participants"
  on public.friend_requests for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists "Users can send friend requests" on public.friend_requests;
create policy "Users can send friend requests"
  on public.friend_requests for insert to authenticated
  with check (sender_id = auth.uid() and recipient_id <> auth.uid());

drop policy if exists "Recipients can accept or reject friend requests" on public.friend_requests;
create policy "Recipients can accept or reject friend requests"
  on public.friend_requests for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid() and status in ('accepted', 'rejected'));

drop policy if exists "Participants can remove friend requests" on public.friend_requests;
create policy "Participants can remove friend requests"
  on public.friend_requests for delete to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());
