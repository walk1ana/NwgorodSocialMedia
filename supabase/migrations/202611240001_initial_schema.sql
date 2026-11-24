-- NewGorod initial production schema
-- Run once in Supabase Dashboard -> SQL Editor.
-- Uses auth.uid() and Supabase Storage. Never expose service_role keys in the client.

create extension if not exists pgcrypto;

-- Profiles are created automatically for new Auth users.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null default 'Горожанин',
  bio text not null default '',
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_length check (username is null or char_length(username) between 3 and 30),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 40),
  constraint profiles_bio_length check (char_length(bio) <= 300)
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz,
  is_hidden boolean not null default false,
  constraint posts_body_or_image check (char_length(trim(body)) > 0 or image_path is not null),
  constraint posts_body_length check (char_length(body) <= 5000)
);
create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists posts_author_created_idx on public.posts(author_id, created_at desc);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  is_hidden boolean not null default false,
  constraint comments_body_length check (char_length(trim(body)) between 1 and 2000)
);
create index if not exists comments_post_created_idx on public.comments(post_id, created_at);

create table if not exists public.likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self check (follower_id <> following_id)
);
create index if not exists follows_following_idx on public.follows(following_id);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  media_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint stories_content check (char_length(body) <= 1000 and (char_length(trim(body)) > 0 or media_path is not null))
);
create index if not exists stories_expiry_idx on public.stories(expires_at);

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
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);

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
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind check (kind in ('like','comment','follow','message','moderation'))
);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  reason text not null,
  details text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  constraint reports_target_type check (target_type in ('post','comment','profile','message')),
  constraint reports_reason_length check (char_length(trim(reason)) between 2 and 120),
  constraint reports_details_length check (char_length(details) <= 2000),
  constraint reports_status check (status in ('open','reviewing','resolved','dismissed'))
);
create index if not exists reports_status_created_idx on public.reports(status, created_at);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  moderator_id uuid not null references public.profiles(id) on delete restrict,
  target_type text not null,
  target_id uuid not null,
  action text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- Admin/moderator privileges are assigned only by trusted server-side tooling
-- through auth.users.app_metadata.role, never user_metadata.
create or replace function public.is_moderator()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin','moderator'), false);
$$;

create or replace function public.is_conversation_member(cid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = cid and cm.user_id = auth.uid()
  );
$$;

-- Create a profile on signup. Email prefix is only a starting display name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text;
begin
  candidate := coalesce(nullif(split_part(new.email, '@', 1), ''), 'Горожанин');
  insert into public.profiles(id, display_name)
  values (new.id, left(candidate, 40))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_newgorod on auth.users;
create trigger on_auth_user_created_newgorod
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Backfill existing accounts.
insert into public.profiles(id, display_name)
select id, left(coalesce(nullif(split_part(email, '@', 1), ''), 'Горожанин'), 40)
from auth.users
on conflict (id) do nothing;

-- Enable RLS everywhere.
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.follows enable row level security;
alter table public.stories enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public.blocks enable row level security;
alter table public.moderation_actions enable row level security;

-- Profiles
drop policy if exists "Profiles are readable by signed-in users" on public.profiles;
create policy "Profiles are readable by signed-in users" on public.profiles
for select to authenticated using (true);
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Posts
drop policy if exists "Visible posts readable" on public.posts;
create policy "Visible posts readable" on public.posts
for select to authenticated using (not is_hidden or author_id = auth.uid() or public.is_moderator());
drop policy if exists "Users create own posts" on public.posts;
create policy "Users create own posts" on public.posts
for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "Users update own posts" on public.posts;
create policy "Users update own posts" on public.posts
for update to authenticated using (author_id = auth.uid() or public.is_moderator())
with check (author_id = auth.uid() or public.is_moderator());
drop policy if exists "Users delete own posts or moderator" on public.posts;
create policy "Users delete own posts or moderator" on public.posts
for delete to authenticated using (author_id = auth.uid() or public.is_moderator());

-- Comments
drop policy if exists "Visible comments readable" on public.comments;
create policy "Visible comments readable" on public.comments
for select to authenticated using (not is_hidden or author_id = auth.uid() or public.is_moderator());
drop policy if exists "Users create own comments" on public.comments;
create policy "Users create own comments" on public.comments
for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "Users delete own comments or moderator" on public.comments;
create policy "Users delete own comments or moderator" on public.comments
for delete to authenticated using (author_id = auth.uid() or public.is_moderator());

-- Likes
drop policy if exists "Likes readable to signed-in users" on public.likes;
create policy "Likes readable to signed-in users" on public.likes
for select to authenticated using (true);
drop policy if exists "Users manage own likes" on public.likes;
create policy "Users manage own likes" on public.likes
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Follows
drop policy if exists "Follows readable to signed-in users" on public.follows;
create policy "Follows readable to signed-in users" on public.follows
for select to authenticated using (true);
drop policy if exists "Users manage own follows" on public.follows;
create policy "Users manage own follows" on public.follows
for all to authenticated using (follower_id = auth.uid()) with check (follower_id = auth.uid());

-- Stories
drop policy if exists "Unexpired stories readable" on public.stories;
create policy "Unexpired stories readable" on public.stories
for select to authenticated using (expires_at > now() or author_id = auth.uid() or public.is_moderator());
drop policy if exists "Users create own stories" on public.stories;
create policy "Users create own stories" on public.stories
for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "Users delete own stories or moderator" on public.stories;
create policy "Users delete own stories or moderator" on public.stories
for delete to authenticated using (author_id = auth.uid() or public.is_moderator());

-- Conversations: only members can see a conversation.
drop policy if exists "Members read conversations" on public.conversations;
create policy "Members read conversations" on public.conversations
for select to authenticated using (public.is_conversation_member(id) or public.is_moderator());
drop policy if exists "Signed-in users create conversations" on public.conversations;
create policy "Signed-in users create conversations" on public.conversations
for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "Creator or moderator deletes conversations" on public.conversations;
create policy "Creator or moderator deletes conversations" on public.conversations
for delete to authenticated using (created_by = auth.uid() or public.is_moderator());

-- Membership: a user can see memberships for conversations they belong to.
drop policy if exists "Members read member lists" on public.conversation_members;
create policy "Members read member lists" on public.conversation_members
for select to authenticated using (public.is_conversation_member(conversation_id) or public.is_moderator());
drop policy if exists "Creator adds members" on public.conversation_members;
create policy "Creator adds members" on public.conversation_members
for insert to authenticated with check (
  user_id = auth.uid()
  or exists (select 1 from public.conversations c where c.id = conversation_id and c.created_by = auth.uid())
  or public.is_moderator()
);
drop policy if exists "Users update own membership" on public.conversation_members;
create policy "Users update own membership" on public.conversation_members
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Users leave or moderator removes" on public.conversation_members;
create policy "Users leave or moderator removes" on public.conversation_members
for delete to authenticated using (user_id = auth.uid() or public.is_moderator());

-- Messages: only conversation members can read/send; sender identity is enforced.
drop policy if exists "Members read messages" on public.messages;
create policy "Members read messages" on public.messages
for select to authenticated using (public.is_conversation_member(conversation_id) or public.is_moderator());
drop policy if exists "Members send as themselves" on public.messages;
create policy "Members send as themselves" on public.messages
for insert to authenticated with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "Sender edits own messages" on public.messages;
create policy "Sender edits own messages" on public.messages
for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());
drop policy if exists "Sender or moderator deletes messages" on public.messages;
create policy "Sender or moderator deletes messages" on public.messages
for delete to authenticated using (sender_id = auth.uid() or public.is_moderator());

-- Notifications
drop policy if exists "Users read own notifications" on public.notifications;
create policy "Users read own notifications" on public.notifications
for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users mark own notifications" on public.notifications;
create policy "Users mark own notifications" on public.notifications
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reports: reporter can create and see their own; moderators can review.
drop policy if exists "Users create reports" on public.reports;
create policy "Users create reports" on public.reports
for insert to authenticated with check (reporter_id = auth.uid());
drop policy if exists "Reporter or moderator reads reports" on public.reports;
create policy "Reporter or moderator reads reports" on public.reports
for select to authenticated using (reporter_id = auth.uid() or public.is_moderator());
drop policy if exists "Moderators update reports" on public.reports;
create policy "Moderators update reports" on public.reports
for update to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- Blocks
drop policy if exists "Users see own blocks" on public.blocks;
create policy "Users see own blocks" on public.blocks
for select to authenticated using (blocker_id = auth.uid());
drop policy if exists "Users manage own blocks" on public.blocks;
create policy "Users manage own blocks" on public.blocks
for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- Moderation audit log: visible only to moderators, append-only for moderator.
drop policy if exists "Moderators read audit log" on public.moderation_actions;
create policy "Moderators read audit log" on public.moderation_actions
for select to authenticated using (public.is_moderator());
drop policy if exists "Moderators create audit entries" on public.moderation_actions;
create policy "Moderators create audit entries" on public.moderation_actions
for insert to authenticated with check (moderator_id = auth.uid() and public.is_moderator());

-- Storage buckets. Public read is convenient for public avatars/post media;
-- writes remain restricted to a folder named after the authenticated user UUID.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp']),
  ('post-media', 'post-media', true, 10485760, array['image/jpeg','image/png','image/webp']),
  ('story-media', 'story-media', true, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public media read" on storage.objects;
create policy "Public media read" on storage.objects
for select using (bucket_id in ('avatars','post-media','story-media'));
drop policy if exists "Users upload own media" on storage.objects;
create policy "Users upload own media" on storage.objects
for insert to authenticated with check (
  bucket_id in ('avatars','post-media','story-media')
  and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "Users update own media" on storage.objects;
create policy "Users update own media" on storage.objects
for update to authenticated using (
  bucket_id in ('avatars','post-media','story-media')
  and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id in ('avatars','post-media','story-media')
  and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "Users delete own media" on storage.objects;
create policy "Users delete own media" on storage.objects
for delete to authenticated using (
  bucket_id in ('avatars','post-media','story-media')
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Enable realtime publication for chat and social updates.
do $$
begin
  alter publication supabase_realtime add table public.posts;
exception when duplicate_object then null;
when undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
when undefined_object then null;
end $$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.is_moderator() to authenticated;
grant execute on function public.is_conversation_member(uuid) to authenticated;
