-- Friend requests and an atomic response path for accepting/rejecting them.
-- Requires the existing public.profiles table.

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
drop policy if exists "Participants can remove friend requests" on public.friend_requests;
create policy "Participants can remove friend requests"
  on public.friend_requests for delete to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());

create or replace function public.respond_to_friend_request(p_request_id uuid, p_action text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.friend_requests%rowtype;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('accept', 'reject') then
    raise exception 'Invalid friend request action' using errcode = '22023';
  end if;

  select * into v_request
  from public.friend_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Friend request not found' using errcode = 'P0002';
  end if;
  if v_request.recipient_id <> auth.uid() then
    raise exception 'Only the recipient can respond to this request' using errcode = '42501';
  end if;

  if v_request.status <> 'pending' then
    if p_action = 'accept' and v_request.status = 'accepted' then
      return 'accepted';
    end if;
    if p_action = 'reject' and v_request.status = 'rejected' then
      return 'rejected';
    end if;
    raise exception 'Friend request was already processed' using errcode = '40001';
  end if;

  if p_action = 'accept' then
    delete from public.friend_requests other_request
    where other_request.id <> v_request.id
      and other_request.status = 'pending'
      and (
        (other_request.sender_id = v_request.sender_id and other_request.recipient_id = v_request.recipient_id)
        or (other_request.sender_id = v_request.recipient_id and other_request.recipient_id = v_request.sender_id)
      );
    v_status := 'accepted';
  else
    v_status := 'rejected';
  end if;

  update public.friend_requests
  set status = v_status, updated_at = now()
  where id = v_request.id;
  return v_status;
end;
$$;

revoke all on function public.respond_to_friend_request(uuid, text) from public;
grant execute on function public.respond_to_friend_request(uuid, text) to authenticated;
