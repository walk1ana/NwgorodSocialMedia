const CACHE="newgorod-push-ios-v5";const FILES=["./","./index.html","./styles.css","./app.js","./auth.js","./supabase-integration.js","./manifest.webmanifest","./icon.svg"];self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;if(new URL(e.request.url).pathname.endsWith("/push-config.js")){e.respondWith(fetch(e.request).catch(()=>new Response("window.NWG_PUSH_VAPID_PUBLIC_KEY='';",{headers:{"Content-Type":"application/javascript"}})));return;}e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match("./index.html"))))});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    console.warn("[NewGorod] Invalid push payload.", error);
  }
  event.waitUntil(self.registration.showNotification(payload.title || "NewGorod", {
      body: payload.body || "У тебя новое уведомление.",
      icon: new URL("./icon.svg", self.registration.scope).href,
      badge: new URL("./icon.svg", self.registration.scope).href,
      data: { url: payload.url || self.registration.scope }
    }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    let targetUrl = new URL(event.notification.data?.url || self.registration.scope, self.registration.scope);
    if (targetUrl.origin !== self.location.origin) targetUrl = new URL(self.registration.scope);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === targetUrl.origin) {
        await client.navigate(targetUrl.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});
