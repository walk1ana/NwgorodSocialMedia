import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

type PushType = "message" | "friend_request" | "friend_accepted";
type PushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

function isPushType(value: unknown): value is PushType {
  return value === "message" || value === "friend_request" || value === "friend_accepted";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const appOrigin = "https://walk1ana.github.io";
const appUrl = `${appOrigin}/NwgorodSocialMedia/`;
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function isAllowedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && (
      url.hostname.endsWith(".push.apple.com")
      || url.hostname === "fcm.googleapis.com"
      || url.hostname.endsWith(".push.services.mozilla.com")
    );
  } catch {
    return false;
  }
}

async function sendWebPush(subscription: PushSubscription, payload: string) {
  const request = webpush.generateRequestDetails(subscription, payload, { TTL: 86400 });
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  const response = await fetch(request.endpoint, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "error",
  });
  await response.arrayBuffer();
  if (!response.ok) {
    const error = new Error(`Web Push endpoint returned ${response.status}.`) as Error & { statusCode: number };
    error.statusCode = response.status;
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return respond({ error: "Authentication required." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.error("Push function configuration is incomplete.");
    return respond({ error: "Push notifications are not configured." }, 503);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return respond({ error: "Invalid session." }, 401);

  let input: { type?: unknown; eventId?: unknown };
  try {
    input = await request.json();
  } catch {
    return respond({ error: "Invalid JSON body." }, 400);
  }
  if (!isPushType(input.type) || !isUuid(input.eventId)) {
    return respond({ error: "Invalid notification event." }, 400);
  }
  const type = input.type;
  const eventId = input.eventId;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let recipientId: string;
  let actorId: string;
  let eventKey = "";
  let eventClaimed = false;

  try {
    if (type === "message") {
      const { data: message, error } = await admin.from("messages")
        .select("id,conversation_id,sender_id")
        .eq("id", eventId)
        .maybeSingle();
      if (error) throw error;
      if (!message || message.sender_id !== user.id) return respond({ error: "Message not found." }, 403);

      const [{ data: conversation, error: conversationError }, { data: members, error: membersError }] = await Promise.all([
        admin.from("conversations").select("id,is_group").eq("id", message.conversation_id).maybeSingle(),
        admin.from("conversation_members").select("user_id").eq("conversation_id", message.conversation_id),
      ]);
      if (conversationError) throw conversationError;
      if (membersError) throw membersError;
      if (!conversation || conversation.is_group || members?.length !== 2) {
        return respond({ error: "This conversation cannot send push notifications." }, 403);
      }

      const peer = members.find((member) => member.user_id !== user.id);
      if (!peer || !members.some((member) => member.user_id === user.id)) {
        return respond({ error: "Message recipient is invalid." }, 403);
      }
      const friendshipFilter = `and(sender_id.eq.${user.id},recipient_id.eq.${peer.user_id}),and(sender_id.eq.${peer.user_id},recipient_id.eq.${user.id})`;
      const { data: friendship, error: friendshipError } = await admin.from("friend_requests")
        .select("id")
        .eq("status", "accepted")
        .or(friendshipFilter)
        .limit(1)
        .maybeSingle();
      if (friendshipError) throw friendshipError;
      if (!friendship) return respond({ error: "Conversation is no longer available." }, 403);

      recipientId = peer.user_id;
      actorId = user.id;
      eventKey = `message:${message.id}`;
    } else {
      const { data: relation, error } = await admin.from("friend_requests")
        .select("id,sender_id,recipient_id,status")
        .eq("id", eventId)
        .maybeSingle();
      if (error) throw error;
      if (!relation) return respond({ error: "Friend request not found." }, 403);

      if (type === "friend_request") {
        if (relation.sender_id !== user.id || relation.status !== "pending") {
          return respond({ error: "Friend request is not valid." }, 403);
        }
        recipientId = relation.recipient_id;
        actorId = relation.sender_id;
      } else {
        if (relation.recipient_id !== user.id || relation.status !== "accepted") {
          return respond({ error: "Friend acceptance is not valid." }, 403);
        }
        recipientId = relation.sender_id;
        actorId = relation.recipient_id;
      }
      eventKey = `${type}:${relation.id}`;
    }

    const expiresBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: expiredEventsError } = await admin.from("push_notification_events")
      .delete()
      .lt("created_at", expiresBefore);
    if (expiredEventsError) throw expiredEventsError;

    const { error: claimError } = await admin.from("push_notification_events").insert({ event_key: eventKey });
    if (claimError?.code === "23505") return respond({ sent: 0, duplicate: true });
    if (claimError) throw claimError;
    eventClaimed = true;

    const [{ data: profile, error: profileError }, { data: subscriptions, error: subscriptionsError }] = await Promise.all([
      admin.from("profiles").select("display_name").eq("id", actorId).maybeSingle(),
      admin.from("push_subscriptions").select("endpoint,subscription").eq("user_id", recipientId),
    ]);
    if (profileError) throw profileError;
    if (subscriptionsError) throw subscriptionsError;

    const actorName = profile?.display_name || "Друг";
    const isMessage = type === "message";
    const title = isMessage ? "Новое сообщение"
      : type === "friend_accepted" ? "Новые друзья" : "Заявка в друзья";
    const body = type === "friend_accepted"
      ? `${actorName} принял(а) твою заявку в друзья.`
      : type === "friend_request"
        ? `${actorName} отправил(а) заявку в друзья.`
        : `${actorName} написал(а) тебе.`;
    const targetUrl = new URL(appUrl);
    targetUrl.searchParams.set("view", isMessage ? "messagesView" : "friendsView");
    if (isMessage) targetUrl.searchParams.set("friend", actorId);

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    const allSubscriptions = subscriptions || [];
    const validSubscriptions = allSubscriptions
      .filter((row) => isAllowedPushEndpoint(row.endpoint));
    const payload = JSON.stringify({ title, body, url: targetUrl.href });
    const results = await Promise.allSettled(validSubscriptions.map((row) =>
      sendWebPush(row.subscription as PushSubscription, payload)
    ));

    const expiredEndpoints = results.flatMap((result, index) =>
      result.status === "rejected" && [404, 410].includes(result.reason?.statusCode)
        ? [validSubscriptions[index].endpoint]
        : []);
    if (expiredEndpoints.length) {
      const { error: deleteError } = await admin.from("push_subscriptions")
        .delete()
        .in("endpoint", expiredEndpoints);
      if (deleteError) console.error("Could not remove expired push subscriptions.", deleteError);
    }

    const sent = results.filter((result) => result.status === "fulfilled").length;
    const rejected = results.length - sent + allSubscriptions.length - validSubscriptions.length;
    if (rejected) console.error(`Push delivery failed for ${rejected} subscription(s).`);
    eventClaimed = false;
    return respond({ sent, failed: rejected });
  } catch (error) {
    if (eventClaimed && eventKey) {
      try {
        const { error: cleanupError } = await admin.from("push_notification_events").delete().eq("event_key", eventKey);
        if (cleanupError) console.error("Could not release failed push notification claim.", cleanupError);
      } catch (cleanupError) {
        console.error("Could not release failed push notification claim.", cleanupError);
      }
    }
    console.error("Push delivery failed.", error);
    return respond({ error: "Could not send this notification." }, 500);
  }
});
