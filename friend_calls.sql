-- Run once in Supabase SQL Editor after public.friend_requests exists.
-- Private call channels are limited to the two users in an accepted friendship.

create or replace function public.can_access_friend_call_channel()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_first uuid;
  v_second uuid;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_parts := string_to_array(coalesce(realtime.topic(), ''), ':');
  if array_length(v_parts, 1) <> 3 or v_parts[1] <> 'friend-call' then
    return false;
  end if;

  begin
    v_first := v_parts[2]::uuid;
    v_second := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  if v_first::text >= v_second::text
    or (auth.uid() <> v_first and auth.uid() <> v_second) then
    return false;
  end if;

  return exists (
    select 1
    from public.friend_requests fr
    where fr.status = 'accepted'
      and (
        (fr.sender_id = v_first and fr.recipient_id = v_second)
        or (fr.sender_id = v_second and fr.recipient_id = v_first)
      )
  );
end;
$$;

create or replace function public.can_send_friend_call_signal(p_payload jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_first uuid;
  v_second uuid;
  v_peer uuid;
begin
  if not public.can_access_friend_call_channel() then
    return false;
  end if;

  v_parts := string_to_array(coalesce(realtime.topic(), ''), ':');
  begin
    v_first := v_parts[2]::uuid;
    v_second := v_parts[3]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  v_peer := case when auth.uid() = v_first then v_second else v_first end;
  return p_payload is not null
    and p_payload ->> 'from' = auth.uid()::text
    and p_payload ->> 'to' = v_peer::text
    and p_payload ->> 'type' in ('offer', 'answer', 'ice', 'decline', 'cancel', 'end', 'missed', 'busy');
end;
$$;

revoke all on function public.can_access_friend_call_channel() from public;
revoke all on function public.can_send_friend_call_signal(jsonb) from public;
grant execute on function public.can_access_friend_call_channel() to authenticated;
grant execute on function public.can_send_friend_call_signal(jsonb) to authenticated;

drop policy if exists "Friend call participants can receive signals" on realtime.messages;
create policy "Friend call participants can receive signals"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and public.can_access_friend_call_channel()
  );

drop policy if exists "Friends can send call signals" on realtime.messages;
create policy "Friends can send call signals"
  on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and public.can_send_friend_call_signal(payload)
  );
