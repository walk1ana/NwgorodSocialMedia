-- NewGorod Social Modules 2.0
-- Safe to run after the existing NewGorod core schema and profile customization migration.

create extension if not exists pgcrypto;

-- Moderation role is taken from trusted Supabase JWT app_metadata (never user_metadata).
create or replace function public.newgorod_is_moderator()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin','moderator'); $$;
revoke all on function public.newgorod_is_moderator() from public;
grant execute on function public.newgorod_is_moderator() to authenticated;

create or replace function public.newgorod_is_group_member(p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.group_chat_members where group_id=p_group and user_id=p_user); $$;
create or replace function public.newgorod_is_community_member(p_community uuid,p_user uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.community_members where community_id=p_community and user_id=p_user); $$;
revoke all on function public.newgorod_is_group_member(uuid,uuid) from public;
revoke all on function public.newgorod_is_community_member(uuid,uuid) from public;
grant execute on function public.newgorod_is_group_member(uuid,uuid) to authenticated;
grant execute on function public.newgorod_is_community_member(uuid,uuid) to authenticated;


-- Reactions and reposts. post_id is text intentionally: it supports the existing
-- installation's post key type without forcing a destructive type conversion.
create table if not exists public.post_reactions (
  post_id text not null, user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null default 'like' check (reaction in ('like','love','laugh','wow','sad','angry')),
  created_at timestamptz not null default now(), primary key (post_id,user_id)
);
create index if not exists post_reactions_post_idx on public.post_reactions(post_id);

create table if not exists public.post_reposts (
  id uuid primary key default gen_random_uuid(), post_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  caption text not null default '' check (char_length(caption) <= 500),
  created_at timestamptz not null default now(), unique(post_id,user_id)
);
create index if not exists post_reposts_created_idx on public.post_reposts(created_at desc);

-- Group chats
create table if not exists public.group_chats (
  id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 2 and 60),
  description text not null default '' check (char_length(description) <= 300),
  owner_id uuid not null references auth.users(id) on delete cascade,
  is_private boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.group_chat_members (
  group_id uuid not null references public.group_chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('owner','admin','member')),
  joined_at timestamptz not null default now(), primary key(group_id,user_id)
);
create table if not exists public.group_chat_messages (
  id uuid primary key default gen_random_uuid(), group_id uuid not null references public.group_chats(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000), created_at timestamptz not null default now(),
  is_deleted boolean not null default false
);
create index if not exists group_chat_messages_idx on public.group_chat_messages(group_id,created_at desc);

-- Communities
create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 2 and 70),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,70}$'),
  description text not null default '' check (char_length(description) <= 1000),
  owner_id uuid not null references auth.users(id) on delete cascade,
  is_private boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.community_members (
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('owner','moderator','member')),
  joined_at timestamptz not null default now(), primary key(community_id,user_id)
);
create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(), community_id uuid not null references public.communities(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 5000), created_at timestamptz not null default now()
);
create index if not exists community_posts_idx on public.community_posts(community_id,created_at desc);

-- Achievements and XP
create table if not exists public.achievements (
  code text primary key, title text not null, description text not null default '', icon text not null default '🏅',
  xp_reward integer not null default 0 check (xp_reward between 0 and 10000), created_at timestamptz not null default now()
);
create table if not exists public.user_xp (
  user_id uuid primary key references auth.users(id) on delete cascade,
  xp integer not null default 0 check (xp >= 0), level integer not null default 1 check (level >= 1),
  updated_at timestamptz not null default now()
);
create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_code text not null references public.achievements(code) on delete cascade,
  earned_at timestamptz not null default now(), primary key(user_id,achievement_code)
);
create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null, reference_id text not null, xp_awarded integer not null check (xp_awarded > 0),
  created_at timestamptz not null default now(), unique(user_id,event_type,reference_id)
);
insert into public.achievements(code,title,description,icon,xp_reward) values
 ('first_post','Первый пост','Опубликуй первую запись','✍️',25),
 ('social_butterfly','На связи','Вступи в три сообщества','🦋',75),
 ('creator','Создатель','Создай первое сообщество','🏙️',50),
 ('level_5','Пятый уровень','Получи 1600 XP','⭐',100),
 ('market_starter','Первое объявление','Размести первый товар','🛍️',30)
on conflict(code) do nothing;

create or replace function public.award_newgorod_xp(p_event_type text,p_reference_id text)
returns integer language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_xp integer; v_total integer; v_valid boolean := false;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_event_type not in ('repost','community_create','community_join','poll_create','event_create','marketplace_create','video_upload','group_create') then
    raise exception 'Unsupported XP event';
  end if;
  case p_event_type
    when 'repost' then select exists(select 1 from public.post_reposts where post_id=p_reference_id and user_id=v_user) into v_valid;
    when 'community_create' then select exists(select 1 from public.communities where id::text=p_reference_id and owner_id=v_user) into v_valid;
    when 'community_join' then select exists(select 1 from public.community_members where community_id::text=p_reference_id and user_id=v_user) into v_valid;
    when 'poll_create' then select exists(select 1 from public.polls where id::text=p_reference_id and creator_id=v_user) into v_valid;
    when 'event_create' then select exists(select 1 from public.events where id::text=p_reference_id and creator_id=v_user) into v_valid;
    when 'marketplace_create' then select exists(select 1 from public.marketplace_items where id::text=p_reference_id and seller_id=v_user) into v_valid;
    when 'video_upload' then select exists(select 1 from public.videos where id::text=p_reference_id and creator_id=v_user) into v_valid;
    when 'group_create' then select exists(select 1 from public.group_chats where id::text=p_reference_id and owner_id=v_user) into v_valid;
  end case;
  if not v_valid then raise exception 'XP event does not match an action owned by this user'; end if;
  v_xp := case p_event_type when 'repost' then 5 when 'community_create' then 50
    when 'community_join' then 10 when 'poll_create' then 15 when 'event_create' then 20
    when 'marketplace_create' then 30 when 'video_upload' then 20 when 'group_create' then 20 else 5 end;
  insert into public.xp_events(user_id,event_type,reference_id,xp_awarded)
  values(v_user,p_event_type,coalesce(p_reference_id,''),v_xp) on conflict(user_id,event_type,reference_id) do nothing;
  if not found then return 0; end if;
  insert into public.user_xp(user_id,xp,level,updated_at) values(v_user,v_xp,1,now())
  on conflict(user_id) do update set xp=public.user_xp.xp+excluded.xp,
    level=greatest(1,floor(sqrt((public.user_xp.xp+excluded.xp)::numeric/100))::integer+1),updated_at=now();
  select xp into v_total from public.user_xp where user_id=v_user;
  if v_total >= 1600 then insert into public.user_achievements(user_id,achievement_code) values(v_user,'level_5') on conflict do nothing; end if;
  return v_xp;
end; $$;
revoke all on function public.award_newgorod_xp(text,text) from public;
grant execute on function public.award_newgorod_xp(text,text) to authenticated;

-- Notifications
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null, kind text not null check (kind in
    ('reaction','repost','group_message','community','achievement','poll','event','marketplace','moderation','system')),
  title text not null check (char_length(title) between 1 and 120), body text not null default '' check (char_length(body)<=500),
  target_type text, target_id text, is_read boolean not null default false, created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id,is_read,created_at desc);

-- Moderation and reports
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(), reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('post','user','message','community','group','marketplace','video','comment')),
  target_id text not null, reason text not null check (reason in ('spam','harassment','hate','violence','sexual','scam','copyright','other')),
  details text not null default '' check (char_length(details)<=2000), status text not null default 'open' check (status in ('open','reviewing','resolved','rejected')),
  created_at timestamptz not null default now(), unique(reporter_id,target_type,target_id)
);
create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(), moderator_id uuid not null references auth.users(id) on delete restrict,
  report_id uuid references public.reports(id) on delete set null, target_type text not null, target_id text not null,
  action text not null check (action in ('warning','hide','restore','suspend','ban','dismiss')),
  note text not null default '' check (char_length(note)<=2000), created_at timestamptz not null default now()
);

-- Polls
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) between 5 and 240),
  options jsonb not null check (jsonb_typeof(options)='array' and jsonb_array_length(options) between 2 and 8),
  ends_at timestamptz, created_at timestamptz not null default now(), is_closed boolean not null default false
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  option_index integer not null check(option_index between 0 and 7), created_at timestamptz not null default now(), primary key(poll_id,user_id)
);

-- Events
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check(char_length(title) between 3 and 120), description text not null default '' check(char_length(description)<=3000),
  venue text not null default '' check(char_length(venue)<=200), starts_at timestamptz not null,
  ends_at timestamptz, capacity integer check(capacity is null or capacity between 1 and 100000),
  created_at timestamptz not null default now(), check(ends_at is null or ends_at>starts_at)
);
create table if not exists public.event_participants (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'going' check(status in ('going','interested','cancelled')),
  created_at timestamptz not null default now(), primary key(event_id,user_id)
);

-- Marketplace
create table if not exists public.marketplace_items (
  id uuid primary key default gen_random_uuid(), seller_id uuid not null references auth.users(id) on delete cascade,
  title text not null check(char_length(title) between 3 and 100), description text not null default '' check(char_length(description)<=3000),
  price numeric(12,2) not null check(price>=0), currency text not null default 'GBP' check(currency in ('GBP','EUR','USD','RUB')),
  category text not null default 'other' check(category in ('electronics','home','fashion','services','vehicles','other')),
  image_path text, status text not null default 'active' check(status in ('active','reserved','sold','hidden')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists marketplace_active_idx on public.marketplace_items(status,created_at desc);

-- Video posts (metadata; binary files live in the private/public Storage bucket).
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check(char_length(title) between 3 and 120), description text not null default '' check(char_length(description)<=2000),
  storage_path text not null, thumbnail_path text, visibility text not null default 'public' check(visibility in ('public','unlisted','private')),
  status text not null default 'processing' check(status in ('processing','ready','blocked','failed')),
  duration_seconds integer check(duration_seconds is null or duration_seconds between 1 and 86400),
  created_at timestamptz not null default now()
);
create index if not exists videos_feed_idx on public.videos(visibility,status,created_at desc);

-- RLS on every module table
alter table public.post_reactions enable row level security;
alter table public.post_reposts enable row level security;
alter table public.group_chats enable row level security;
alter table public.group_chat_members enable row level security;
alter table public.group_chat_messages enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_posts enable row level security;
alter table public.achievements enable row level security;
alter table public.user_xp enable row level security;
alter table public.user_achievements enable row level security;
alter table public.xp_events enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;
alter table public.events enable row level security;
alter table public.event_participants enable row level security;
alter table public.marketplace_items enable row level security;
alter table public.videos enable row level security;

-- Reactions / reposts
create policy "Reactions readable by signed-in users" on public.post_reactions for select to authenticated using(true);
create policy "Users manage own reactions" on public.post_reactions for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid() and exists(select 1 from public.posts p where p.id::text=post_id and coalesce(p.is_hidden,false)=false));
create policy "Reposts readable by signed-in users" on public.post_reposts for select to authenticated using(true);
create policy "Users manage own reposts" on public.post_reposts for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid() and exists(select 1 from public.posts p where p.id::text=post_id and coalesce(p.is_hidden,false)=false));

-- Group chats: only members can see the chat and messages.
create policy "Members read group chats" on public.group_chats for select to authenticated using(not is_private or public.newgorod_is_group_member(id,auth.uid()) or owner_id=auth.uid());
create policy "Authenticated users create groups" on public.group_chats for insert to authenticated with check(owner_id=auth.uid());
create policy "Owners update groups" on public.group_chats for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy "Owners delete groups" on public.group_chats for delete to authenticated using(owner_id=auth.uid());
create policy "Members read group membership" on public.group_chat_members for select to authenticated using(user_id=auth.uid() or public.newgorod_is_group_member(group_id,auth.uid()));
create policy "Users join public groups" on public.group_chat_members for insert to authenticated with check(user_id=auth.uid() and member_role='member' and exists(select 1 from public.group_chats g where g.id=group_id and not g.is_private));
create policy "Group owners add themselves" on public.group_chat_members for insert to authenticated with check(user_id=auth.uid() and member_role='owner' and exists(select 1 from public.group_chats g where g.id=group_id and g.owner_id=auth.uid()));
create policy "Users leave groups or owners manage members" on public.group_chat_members for delete to authenticated using(user_id=auth.uid() or exists(select 1 from public.group_chats g where g.id=group_id and g.owner_id=auth.uid()));
create policy "Group members read messages" on public.group_chat_messages for select to authenticated using(public.newgorod_is_group_member(group_id,auth.uid()));
create policy "Group members send messages" on public.group_chat_messages for insert to authenticated with check(sender_id=auth.uid() and public.newgorod_is_group_member(group_id,auth.uid()));
create policy "Authors delete own group messages" on public.group_chat_messages for update to authenticated using(sender_id=auth.uid() and public.newgorod_is_group_member(group_id,auth.uid())) with check(sender_id=auth.uid() and public.newgorod_is_group_member(group_id,auth.uid()));

-- Communities
create policy "Public communities readable" on public.communities for select to authenticated using(not is_private or owner_id=auth.uid() or exists(select 1 from public.community_members m where m.community_id=id and m.user_id=auth.uid()));
create policy "Users create communities" on public.communities for insert to authenticated with check(owner_id=auth.uid());
create policy "Owners update communities" on public.communities for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy "Owners delete communities" on public.communities for delete to authenticated using(owner_id=auth.uid());
create policy "Members read community members" on public.community_members for select to authenticated using(user_id=auth.uid() or public.newgorod_is_community_member(community_id,auth.uid()));
create policy "Users join public communities" on public.community_members for insert to authenticated with check(user_id=auth.uid() and member_role='member' and exists(select 1 from public.communities c where c.id=community_id and not c.is_private));
create policy "Community owners add themselves" on public.community_members for insert to authenticated with check(user_id=auth.uid() and member_role='owner' and exists(select 1 from public.communities c where c.id=community_id and c.owner_id=auth.uid()));
create policy "Users leave communities" on public.community_members for delete to authenticated using(user_id=auth.uid() or exists(select 1 from public.communities c where c.id=community_id and c.owner_id=auth.uid()));
create policy "Members read community posts" on public.community_posts for select to authenticated using(public.newgorod_is_community_member(community_id,auth.uid()));
create policy "Members create community posts" on public.community_posts for insert to authenticated with check(author_id=auth.uid() and public.newgorod_is_community_member(community_id,auth.uid()));
create policy "Authors delete community posts" on public.community_posts for delete to authenticated using(author_id=auth.uid() or public.newgorod_is_moderator());

-- Achievements and XP: read-only for clients; XP changes only through RPC.
create policy "Achievements are public" on public.achievements for select to authenticated using(true);
create policy "Users read own XP" on public.user_xp for select to authenticated using(user_id=auth.uid());
create policy "Users read own achievements" on public.user_achievements for select to authenticated using(user_id=auth.uid());
create policy "Users read own XP events" on public.xp_events for select to authenticated using(user_id=auth.uid());

-- Notifications
create policy "Users read own notifications" on public.notifications for select to authenticated using(user_id=auth.uid());
create or replace function public.newgorod_mark_notification_read(p_notification_id uuid)
returns void language plpgsql security definer set search_path=public
as $$ begin update public.notifications set is_read=true where id=p_notification_id and user_id=auth.uid(); end; $$;
revoke all on function public.newgorod_mark_notification_read(uuid) from public;
grant execute on function public.newgorod_mark_notification_read(uuid) to authenticated;
revoke update on public.notifications from authenticated;

-- Reports and moderation
create policy "Users submit reports" on public.reports for insert to authenticated with check(reporter_id=auth.uid());
create policy "Users read own reports and moderators read all" on public.reports for select to authenticated using(reporter_id=auth.uid() or public.newgorod_is_moderator());
create policy "Moderators update reports" on public.reports for update to authenticated using(public.newgorod_is_moderator()) with check(public.newgorod_is_moderator());
create policy "Moderators read moderation actions" on public.moderation_actions for select to authenticated using(public.newgorod_is_moderator());
create policy "Moderators create moderation actions" on public.moderation_actions for insert to authenticated with check(moderator_id=auth.uid() and public.newgorod_is_moderator());

-- Polls and votes
create policy "Polls readable by signed-in users" on public.polls for select to authenticated using(true);
create policy "Users create polls" on public.polls for insert to authenticated with check(creator_id=auth.uid());
create policy "Creators manage polls" on public.polls for update to authenticated using(creator_id=auth.uid()) with check(creator_id=auth.uid());
create policy "Votes readable by signed-in users" on public.poll_votes for select to authenticated using(true);
create policy "Users vote once" on public.poll_votes for insert to authenticated with check(user_id=auth.uid() and exists(select 1 from public.polls p where p.id=poll_id and not p.is_closed and (p.ends_at is null or p.ends_at>now()) and option_index < jsonb_array_length(p.options)));
create policy "Users change own poll vote" on public.poll_votes for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid() and exists(select 1 from public.polls p where p.id=poll_id and not p.is_closed and (p.ends_at is null or p.ends_at>now()) and option_index<jsonb_array_length(p.options)));
create policy "Users remove own poll vote" on public.poll_votes for delete to authenticated using(user_id=auth.uid());

-- Events
create policy "Events readable by signed-in users" on public.events for select to authenticated using(true);
create policy "Users create events" on public.events for insert to authenticated with check(creator_id=auth.uid());
create policy "Creators manage events" on public.events for update to authenticated using(creator_id=auth.uid()) with check(creator_id=auth.uid());
create policy "Participants readable" on public.event_participants for select to authenticated using(true);
create policy "Users RSVP as themselves" on public.event_participants for insert to authenticated with check(user_id=auth.uid());
create policy "Users update own RSVP" on public.event_participants for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "Users cancel own RSVP" on public.event_participants for delete to authenticated using(user_id=auth.uid());

-- Marketplace
create policy "Active marketplace listings readable" on public.marketplace_items for select to authenticated using(status='active' or seller_id=auth.uid() or public.newgorod_is_moderator());
create policy "Users create own listings" on public.marketplace_items for insert to authenticated with check(seller_id=auth.uid());
create policy "Sellers update own listings" on public.marketplace_items for update to authenticated using(seller_id=auth.uid()) with check(seller_id=auth.uid());
create policy "Sellers delete own listings" on public.marketplace_items for delete to authenticated using(seller_id=auth.uid() or public.newgorod_is_moderator());

-- Videos
create policy "Public ready videos readable" on public.videos for select to authenticated using((visibility='public' and status='ready') or creator_id=auth.uid() or public.newgorod_is_moderator());
create policy "Users upload own video metadata" on public.videos for insert to authenticated with check(creator_id=auth.uid() and status='processing');
create policy "Creators update own videos" on public.videos for update to authenticated using(creator_id=auth.uid()) with check(creator_id=auth.uid());
create policy "Creators delete own videos" on public.videos for delete to authenticated using(creator_id=auth.uid() or public.newgorod_is_moderator());

grant select,insert,update,delete on public.post_reactions,public.post_reposts,public.group_chats,public.group_chat_members,public.group_chat_messages,public.communities,public.community_members,public.community_posts,public.achievements,public.user_xp,public.user_achievements,public.xp_events,public.notifications,public.reports,public.moderation_actions,public.polls,public.poll_votes,public.events,public.event_participants,public.marketplace_items,public.videos to authenticated;
revoke insert on public.notifications from public,anon,authenticated;

drop policy if exists "Moderators update reported posts" on public.posts;
create policy "Moderators update reported posts" on public.posts for update to authenticated using(public.newgorod_is_moderator()) with check(public.newgorod_is_moderator());
drop policy if exists "Moderators update marketplace listings" on public.marketplace_items;
create policy "Moderators update marketplace listings" on public.marketplace_items for update to authenticated using(public.newgorod_is_moderator()) with check(public.newgorod_is_moderator());
drop policy if exists "Moderators update video status" on public.videos;
create policy "Moderators update video status" on public.videos for update to authenticated using(public.newgorod_is_moderator()) with check(public.newgorod_is_moderator());

-- Storage buckets for user media. Video bucket is capped at 250 MB per object.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('marketplace-media','marketplace-media',true,10485760,array['image/jpeg','image/png','image/webp']),
 ('community-media','community-media',true,10485760,array['image/jpeg','image/png','image/webp']),
 ('newgorod-videos','newgorod-videos',false,262144000,array['video/mp4','video/webm','video/quicktime'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "NewGorod module media public read" on storage.objects;
create policy "NewGorod module media public read" on storage.objects for select to authenticated
using(bucket_id in ('marketplace-media','community-media') or (bucket_id='newgorod-videos' and exists(select 1 from public.videos v where v.storage_path=name and ((v.visibility='public' and v.status='ready') or v.creator_id=auth.uid()))));
drop policy if exists "NewGorod users upload module media" on storage.objects;
create policy "NewGorod users upload module media" on storage.objects for insert to authenticated
with check(bucket_id in ('marketplace-media','community-media','newgorod-videos') and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "NewGorod users delete own module media" on storage.objects;
create policy "NewGorod users delete own module media" on storage.objects for delete to authenticated
using(bucket_id in ('marketplace-media','community-media','newgorod-videos') and (storage.foldername(name))[1]=auth.uid()::text);

-- Minimal server-side event triggers for profile XP and first-post achievement.
create or replace function public.newgorod_on_post_created()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  insert into public.user_achievements(user_id,achievement_code) values(new.author_id,'first_post') on conflict do nothing;
  insert into public.user_xp(user_id,xp,level,updated_at) values(new.author_id,25,1,now())
  on conflict(user_id) do update set xp=public.user_xp.xp+25,level=greatest(1,floor(sqrt((public.user_xp.xp+25)::numeric/100))::integer+1),updated_at=now();
  return new;
end; $$;
drop trigger if exists newgorod_post_xp on public.posts;
create trigger newgorod_post_xp after insert on public.posts for each row execute function public.newgorod_on_post_created();

create or replace function public.newgorod_check_event_capacity() returns trigger language plpgsql security definer set search_path=public as $$
declare v_capacity integer; v_count integer;
begin
  if new.status<>'going' then return new; end if;
  select capacity into v_capacity from public.events where id=new.event_id for update;
  if v_capacity is null then return new; end if;
  select count(*) into v_count from public.event_participants where event_id=new.event_id and status='going' and user_id<>new.user_id;
  if v_count>=v_capacity then raise exception 'Мест на мероприятии больше нет'; end if;
  return new;
end; $$;
drop trigger if exists newgorod_event_capacity on public.event_participants;
create trigger newgorod_event_capacity before insert or update on public.event_participants for each row execute function public.newgorod_check_event_capacity();

-- Notification fan-out. Trigger functions run with owner privileges and never trust client-supplied recipient IDs.
create or replace function public.newgorod_notify_post_reaction() returns trigger language plpgsql security definer set search_path=public as $$
declare v_author uuid;
begin
  select author_id into v_author from public.posts where id::text=new.post_id limit 1;
  if v_author is not null and v_author<>new.user_id then
    insert into public.notifications(user_id,actor_id,kind,title,body,target_type,target_id)
    values(v_author,new.user_id,'reaction','Новая реакция','Кто-то отреагировал на твою публикацию','post',new.post_id);
  end if; return new;
end; $$;
drop trigger if exists newgorod_reaction_notification on public.post_reactions;
create trigger newgorod_reaction_notification after insert on public.post_reactions for each row execute function public.newgorod_notify_post_reaction();

create or replace function public.newgorod_notify_group_message() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.notifications(user_id,actor_id,kind,title,body,target_type,target_id)
  select m.user_id,new.sender_id,'group_message','Новое сообщение в группе',left(new.body,160),'group',new.group_id::text
  from public.group_chat_members m where m.group_id=new.group_id and m.user_id<>new.sender_id;
  return new;
end; $$;
drop trigger if exists newgorod_group_message_notification on public.group_chat_messages;
create trigger newgorod_group_message_notification after insert on public.group_chat_messages for each row execute function public.newgorod_notify_group_message();

create or replace function public.newgorod_notify_achievement() returns trigger language plpgsql security definer set search_path=public as $$
declare v_title text;
begin
  select title into v_title from public.achievements where code=new.achievement_code;
  insert into public.notifications(user_id,kind,title,body,target_type,target_id)
  values(new.user_id,'achievement','Новое достижение',coalesce(v_title,new.achievement_code),'achievement',new.achievement_code);
  return new;
end; $$;
drop trigger if exists newgorod_achievement_notification on public.user_achievements;
create trigger newgorod_achievement_notification after insert on public.user_achievements for each row execute function public.newgorod_notify_achievement();

create or replace function public.newgorod_notify_repost() returns trigger language plpgsql security definer set search_path=public as $$
declare v_author uuid;
begin
  select author_id into v_author from public.posts where id::text=new.post_id limit 1;
  if v_author is not null and v_author<>new.user_id then
    insert into public.notifications(user_id,actor_id,kind,title,body,target_type,target_id)
    values(v_author,new.user_id,'repost','Твою публикацию репостнули',left(new.caption,160),'post',new.post_id);
  end if; return new;
end; $$;
drop trigger if exists newgorod_repost_notification on public.post_reposts;
create trigger newgorod_repost_notification after insert on public.post_reposts for each row execute function public.newgorod_notify_repost();

create or replace function public.newgorod_notify_event_rsvp() returns trigger language plpgsql security definer set search_path=public as $$
declare v_owner uuid; v_title text;
begin
  select creator_id,title into v_owner,v_title from public.events where id=new.event_id;
  if v_owner is not null and v_owner<>new.user_id and new.status='going' then
    insert into public.notifications(user_id,actor_id,kind,title,body,target_type,target_id)
    values(v_owner,new.user_id,'event','Новый участник мероприятия',v_title,'event',new.event_id::text);
  end if; return new;
end; $$;
drop trigger if exists newgorod_event_rsvp_notification on public.event_participants;
create trigger newgorod_event_rsvp_notification after insert on public.event_participants for each row execute function public.newgorod_notify_event_rsvp();

create or replace function public.newgorod_community_achievements() returns trigger language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if tg_table_name='communities' then
    insert into public.user_achievements(user_id,achievement_code) values(new.owner_id,'creator') on conflict do nothing;
  elsif tg_table_name='community_members' then
    select count(*) into v_count from public.community_members where user_id=new.user_id;
    if v_count>=3 then insert into public.user_achievements(user_id,achievement_code) values(new.user_id,'social_butterfly') on conflict do nothing; end if;
  elsif tg_table_name='marketplace_items' then
    insert into public.user_achievements(user_id,achievement_code) values(new.seller_id,'market_starter') on conflict do nothing;
  end if;
  return new;
end; $$;
drop trigger if exists newgorod_community_creator_achievement on public.communities;
create trigger newgorod_community_creator_achievement after insert on public.communities for each row execute function public.newgorod_community_achievements();
drop trigger if exists newgorod_community_member_achievement on public.community_members;
create trigger newgorod_community_member_achievement after insert on public.community_members for each row execute function public.newgorod_community_achievements();
drop trigger if exists newgorod_market_achievement on public.marketplace_items;
create trigger newgorod_market_achievement after insert on public.marketplace_items for each row execute function public.newgorod_community_achievements();

create or replace function public.newgorod_notify_report() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.notifications(user_id,actor_id,kind,title,body,target_type,target_id)
  select u.id,new.reporter_id,'moderation','Новая жалоба поступила',new.target_type||' · '||new.reason,'report',new.id::text
  from auth.users u where coalesce(u.raw_app_meta_data->>'role','') in ('admin','moderator');
  return new;
end; $$;
drop trigger if exists newgorod_report_notification on public.reports;
create trigger newgorod_report_notification after insert on public.reports for each row execute function public.newgorod_notify_report();

create or replace function public.newgorod_notify_report_status() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status is distinct from old.status then
    insert into public.notifications(user_id,kind,title,body,target_type,target_id)
    values(new.reporter_id,'moderation','Обновлён статус жалобы','Новый статус: '||new.status,'report',new.id::text);
  end if;
  return new;
end; $$;
drop trigger if exists newgorod_report_status_notification on public.reports;
create trigger newgorod_report_status_notification after update of status on public.reports for each row execute function public.newgorod_notify_report_status();

create or replace function public.newgorod_cleanup_post_modules() returns trigger language plpgsql security definer set search_path=public as $$
begin
  delete from public.post_reactions where post_id=old.id::text;
  delete from public.post_reposts where post_id=old.id::text;
  return old;
end; $$;
drop trigger if exists newgorod_post_module_cleanup on public.posts;
create trigger newgorod_post_module_cleanup after delete on public.posts for each row execute function public.newgorod_cleanup_post_modules();

-- Realtime publication (safe when already added).
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.group_chat_messages;
exception when duplicate_object then null; when undefined_object then null; end $$;
