-- Private one-to-one messages for accepted friends.
-- Requires public.profiles and the friend_requests migration.

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx
  on public.conversation_members(user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint messages_body_length check (char_length(trim(body)) between 1 and 10000)
);
create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at desc);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
grant select, insert, update, delete on public.conversations, public.conversation_members, public.messages to authenticated;

create or replace function public.is_conversation_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members own_membership
    join public.conversations c on c.id = own_membership.conversation_id
    where own_membership.conversation_id = cid
      and own_membership.user_id = auth.uid()
      and (
        c.is_group
        or exists (
          select 1
          from public.conversation_members other_membership
          join public.friend_requests fr
            on fr.status = 'accepted'
            and (
              (fr.sender_id = auth.uid() and fr.recipient_id = other_membership.user_id)
              or (fr.recipient_id = auth.uid() and fr.sender_id = other_membership.user_id)
            )
          where other_membership.conversation_id = cid
            and other_membership.user_id <> auth.uid()
        )
      )
  );
$$;

revoke all on function public.is_conversation_member(uuid) from public;
grant execute on function public.is_conversation_member(uuid) to authenticated;

drop policy if exists "Members read conversations" on public.conversations;
create policy "Members read conversations" on public.conversations
  for select to authenticated using (public.is_conversation_member(id));
drop policy if exists "Signed-in users create conversations" on public.conversations;

drop policy if exists "Members read member lists" on public.conversation_members;
create policy "Members read member lists" on public.conversation_members
  for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists "Creator adds members" on public.conversation_members;

drop policy if exists "Members read messages" on public.messages;
create policy "Members read messages" on public.messages
  for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists "Members send as themselves" on public.messages;
create policy "Members send as themselves" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "Sender edits own messages" on public.messages;
create policy "Sender edits own messages" on public.messages
  for update to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(conversation_id))
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "Sender or moderator deletes messages" on public.messages;
create policy "Sender or moderator deletes messages" on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

create or replace function public.open_friend_conversation(p_friend_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_conversation_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_friend_id is null or p_friend_id = v_user_id then
    raise exception 'Invalid friend' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
      and (
        (fr.sender_id = v_user_id and fr.recipient_id = p_friend_id)
        or (fr.recipient_id = v_user_id and fr.sender_id = p_friend_id)
      )
  ) then
    raise exception 'You can only message accepted friends' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    least(v_user_id::text, p_friend_id::text) || ':' || greatest(v_user_id::text, p_friend_id::text),
    0
  ));

  select c.id into v_conversation_id
  from public.conversations c
  where not c.is_group
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = c.id and cm.user_id = v_user_id
    )
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = c.id and cm.user_id = p_friend_id
    )
    and (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
  order by c.created_at desc
  limit 1;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  insert into public.conversations (is_group, created_by)
  values (false, v_user_id)
  returning id into v_conversation_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation_id, v_user_id), (v_conversation_id, p_friend_id);

  return v_conversation_id;
end;
$$;

revoke all on function public.open_friend_conversation(uuid) from public;
grant execute on function public.open_friend_conversation(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
