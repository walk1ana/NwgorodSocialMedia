/* NewGorod: Supabase-backed social features. Loaded after app.js. */
(() => {
  let remoteUser = null;
  let avatarFile = null;
  let postImageFile = null;
  const sb = () => (typeof authClient !== 'undefined' ? authClient : null);
  const uid = () => remoteUser?.id || null;
  async function ensureRemoteUser() {
    if (!sb()) throw new Error('Supabase не подключён.');
    // Всегда сверяем пользователя с текущей Supabase-сессией:
    // remoteUser мог остаться пустым или устареть после перезагрузки/смены аккаунта.
    const { data, error } = await sb().auth.getUser();
    if (error) throw error;
    remoteUser = data?.user || null;
    if (!remoteUser?.id) throw new Error('Сессия не найдена. Войди в аккаунт заново.');
    return remoteUser;
  }
  const reportError = (label, error) => {
    console.error(`[NewGorod] ${label}`, error);
    toast(`${label}: ${error?.message || 'ошибка сервера'}`);
  };
  const pushVapidPublicKey = () => window.NWG_PUSH_VAPID_PUBLIC_KEY || '';
  const hasPushVapidPublicKey = () => /^[A-Za-z0-9_-]{80,100}$/.test(pushVapidPublicKey());
  const isIosDevice = () => /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInstalledWebApp = () => navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  let pushRegistration = null;
  let pushSubscription = null;
  function showPushSetupMessage(message) {
    $('#pushStatus').textContent = message;
  }
  async function refreshPushSettings() {
    const enableButton = $('#enablePushNotifications');
    const disableButton = $('#disablePushNotifications');
    enableButton.disabled = true;
    if (!uid()) {
      showPushSetupMessage('Войди в аккаунт, чтобы настроить уведомления.');
      enableButton.disabled = true;
      disableButton.hidden = true;
      return;
    }
    if (!window.isSecureContext || !('serviceWorker' in navigator)
      || !('PushManager' in window) || !('Notification' in window)) {
      showPushSetupMessage('Этот браузер не поддерживает push-уведомления. Нужен HTTPS и современный браузер.');
      enableButton.disabled = true;
      disableButton.hidden = true;
      return;
    }
    if (isIosDevice() && !isInstalledWebApp()) {
      showPushSetupMessage('На iPhone: Поделиться → «На экран Домой», затем открой NewGorod с иконки.');
      enableButton.disabled = false;
      disableButton.hidden = true;
      return;
    }
    if (!hasPushVapidPublicKey()) {
      showPushSetupMessage('Push ещё не настроен. Добавь публичный VAPID-ключ в push-config.js.');
      enableButton.disabled = true;
      disableButton.hidden = true;
      return;
    }
    if (Notification.permission === 'denied') {
      showPushSetupMessage('Уведомления запрещены. Разреши их в настройках Safari для NewGorod.');
      enableButton.disabled = true;
      disableButton.hidden = true;
      return;
    }
    pushRegistration = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.ready;
    pushSubscription = await pushRegistration.pushManager.getSubscription();
    let subscriptionSaved = false;
    if (Notification.permission === 'granted' && pushSubscription) {
      const { data, error } = await sb().from('push_subscriptions')
        .select('endpoint')
        .eq('endpoint', pushSubscription.endpoint)
        .eq('user_id', uid())
        .maybeSingle();
      if (error) {
        showPushSetupMessage('Не удалось проверить подписку. Проверь SQL ios_push.sql и повтори включение.');
        enableButton.disabled = false;
        disableButton.hidden = true;
        return;
      }
      subscriptionSaved = Boolean(data);
    }
    const enabled = Notification.permission === 'granted' && Boolean(pushSubscription) && subscriptionSaved;
    showPushSetupMessage(enabled
      ? 'Уведомления о сообщениях и заявках включены на этом устройстве.'
      : pushSubscription && Notification.permission === 'granted'
        ? 'Подписка создана, но не сохранена. Нажми «Включить», чтобы повторить.'
        : 'Получай уведомления о новых сообщениях и заявках в друзья.');
    enableButton.disabled = false;
    enableButton.hidden = enabled;
    disableButton.hidden = !enabled;
  }
  function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  }
  async function enablePushNotifications() {
    if (isIosDevice() && !isInstalledWebApp()) {
      showPushSetupMessage('Сначала добавь сайт на экран «Домой» и открой его оттуда.');
      return;
    }
    if (!hasPushVapidPublicKey()) throw new Error('В push-config.js ещё не добавлен публичный VAPID-ключ.');
    if (!window.isSecureContext || !('serviceWorker' in navigator)
      || !('PushManager' in window) || !('Notification' in window)) {
      throw new Error('Нужны HTTPS, Service Worker и браузер с поддержкой Web Push.');
    }
    if (!pushRegistration) throw new Error('Service Worker ещё загружается. Попробуй через секунду.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Разреши уведомления в системном запросе браузера.');
    const subscriptionPromise = pushSubscription
      ? Promise.resolve(pushSubscription)
      : pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(pushVapidPublicKey())
      });
    const userPromise = ensureRemoteUser();
    const [subscription, user] = await Promise.all([subscriptionPromise, userPromise]);
    pushSubscription = subscription;
    const { error } = await sb().from('push_subscriptions').upsert({
      endpoint: subscription.endpoint,
      user_id: user.id,
      subscription: subscription.toJSON(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    await refreshPushSettings();
    toast('Push-уведомления включены.');
  }
  async function disablePushNotifications() {
    const user = await ensureRemoteUser();
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) {
      await refreshPushSettings();
      return;
    }
    const { error } = await sb().from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint)
      .eq('user_id', user.id);
    let localRemovalError = null;
    try {
      await subscription.unsubscribe();
    } catch (unsubscribeError) {
      localRemovalError = unsubscribeError;
    }
    if (error && localRemovalError) throw error;
    pushSubscription = null;
    await refreshPushSettings();
    if (error) {
      console.error('[NewGorod] Удалили push-подписку только на этом устройстве', error);
      toast('Уведомления выключены на этом устройстве; серверная запись осталась.');
    } else if (localRemovalError) {
      throw localRemovalError;
    } else {
      toast('Push-уведомления выключены.');
    }
  }
  window.prepareNewGorodPushLogout = async () => {
    if (!('serviceWorker' in navigator) || !sb()) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    let remoteRemovalError = null;
    try {
      const { data: { user }, error: userError } = await sb().auth.getUser();
      if (userError) throw userError;
      if (user) {
        const { error } = await sb().from('push_subscriptions')
          .delete()
          .eq('endpoint', subscription.endpoint)
          .eq('user_id', user.id);
        if (error) throw error;
      }
    } catch (error) {
      remoteRemovalError = error;
    }
    let localRemovalSucceeded = false;
    try {
      await subscription.unsubscribe();
      localRemovalSucceeded = true;
      pushSubscription = null;
    } catch (error) {
      console.error('[NewGorod] Не удалось удалить локальную push-подписку', error);
    }
    if (remoteRemovalError && !localRemovalSucceeded) throw remoteRemovalError;
  };
  async function sendPushNotification(type, eventId) {
    if (!hasPushVapidPublicKey() || !uid()) return;
    const { error } = await sb().functions.invoke('send-push', {
      body: { type, eventId }
    });
    if (error) console.error('[NewGorod] Не удалось отправить push-уведомление', error);
  }
  function notifyPush(type, eventId) {
    sendPushNotification(type, eventId).catch(error => {
      console.error('[NewGorod] Не удалось отправить push-уведомление', error);
    });
  }
  const publicUrl = (bucket, path) => {
    if (!path) return '';
    return sb().storage.from(bucket).getPublicUrl(path).data.publicUrl;
  };
  async function uploadMedia(bucket, file) {
    if (!file || !uid()) return null;
    const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${uid()}/${crypto.randomUUID()}.${ext}`;
    const { error } = await sb().storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' });
    if (error) throw error;
    return path;
  }
  async function loadRemoteData() {
    if (!sb() || !uid()) return;
    const client = sb();
    const [profileRes, postsRes, commentsRes, likesRes, followsRes, storiesRes] = await Promise.all([
      client.from('profiles').select('*').eq('id', uid()).single(),
      client.from('posts').select('*').eq('is_hidden', false).order('created_at', { ascending: false }).limit(100),
      client.from('comments').select('*').eq('is_hidden', false).order('created_at', { ascending: true }).limit(1000),
      client.from('likes').select('post_id,user_id'),
      client.from('follows').select('follower_id,following_id'),
      client.from('stories').select('*').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(100)
    ]);
    for (const r of [profileRes, postsRes, commentsRes, likesRes, followsRes, storiesRes]) if (r.error) throw r.error;
    const profile = profileRes.data;
    data.name = profile.display_name || 'Горожанин';
    data.bio = profile.bio || '';
    data.avatar = publicUrl('avatars', profile.avatar_path);
    const profilesNeeded = [...new Set([
      ...postsRes.data.map(p => p.author_id),
      ...commentsRes.data.map(c => c.author_id),
      ...storiesRes.data.map(s => s.author_id)
    ])];
    let profiles = [];
    if (profilesNeeded.length) {
      const res = await client.from('profiles').select('id,display_name,avatar_path').in('id', profilesNeeded);
      if (res.error) throw res.error;
      profiles = res.data;
    }
    const profileById = Object.fromEntries(profiles.map(p => [p.id, p]));
    const commentsByPost = {};
    commentsRes.data.forEach(c => {
      (commentsByPost[c.post_id] ||= []).push({ id: c.id, author: profileById[c.author_id]?.display_name || 'Горожанин', text: c.body });
    });
    const likesByPost = {};
    likesRes.data.forEach(l => { (likesByPost[l.post_id] ||= []).push(l.user_id); });
    data.posts = postsRes.data.map(p => {
      const author = profileById[p.author_id] || {};
      const postLikes = likesByPost[p.id] || [];
      return {
        id: p.id, authorId: p.author_id, author: author.display_name || 'Горожанин', initial: (author.display_name || 'Г')[0],
        avatar: publicUrl('avatars', author.avatar_path), time: new Date(p.created_at).toLocaleString(),
        text: p.body, image: publicUrl('post-media', p.image_path), imagePath: p.image_path,
        likes: postLikes.length, liked: postLikes.includes(uid()), comments: commentsByPost[p.id] || []
      };
    });
    data.following = followsRes.data.filter(f => f.follower_id === uid()).map(f => profileById[f.following_id]?.display_name || f.following_id);
    data.stories = storiesRes.data.map(s => {
      const author = profileById[s.author_id] || {};
      return { id: s.id, name: author.display_name || 'Горожанин', initial: (author.display_name || 'Г')[0], text: s.body, image: publicUrl('story-media', s.media_path) };
    });
    render();
  }
  async function refresh() {
    try { await loadRemoteData(); }
    catch (e) { reportError('Не удалось загрузить данные', e); }
  }

  window.addEventListener('newgorod-auth', async event => {
    remoteUser = event.detail?.user || null;
    if (remoteUser) await refresh();
  });

  // All social actions below write to PostgreSQL, not localStorage.
  wirePosts = function(root = document) {
    root.querySelectorAll('[data-like]').forEach(b => b.onclick = async () => {
      const postId = b.dataset.like;
      const post = data.posts.find(p => p.id === postId);
      if (!post) return;
      b.disabled = true;
      try {
        const user = await ensureRemoteUser();
        if (post.liked) {
          const { error } = await sb().from('likes').delete().eq('post_id', postId).eq('user_id', user.id);
          if (error) throw error;
        } else {
          const { error } = await sb().from('likes').insert({ post_id: postId, user_id: user.id });
          if (error) throw error;
        }
        await refresh();
      } catch (e) {
        reportError('Не удалось изменить отметку «Нравится»', e);
      } finally {
        b.disabled = false;
      }
    });
    root.querySelectorAll('[data-comments]').forEach(b => b.onclick = () => openComments(b.dataset.comments));
    root.querySelectorAll('[data-follow]').forEach(b => b.onclick = async () => {
      const name = b.dataset.follow;
      const target = data.posts.find(p => p.author === name && p.authorId !== uid());
      if (!target || !uid()) return;
      try {
        const existing = await sb().from('follows').select('follower_id').eq('follower_id', uid()).eq('following_id', target.authorId).maybeSingle();
        if (existing.error) throw existing.error;
        const result = existing.data
          ? await sb().from('follows').delete().eq('follower_id', uid()).eq('following_id', target.authorId)
          : await sb().from('follows').insert({ follower_id: uid(), following_id: target.authorId });
        if (result.error) throw result.error;
        await refresh();
      } catch (e) { reportError('Не удалось изменить подписку', e); }
    });
    root.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
      const id = b.dataset.save;
      data.savedIds ||= [];
      data.savedIds.includes(id) ? data.savedIds = data.savedIds.filter(x => x !== id) : data.savedIds.push(id);
      try { localStorage.setItem('newgorod-saved-v1-' + uid(), JSON.stringify(data.savedIds)); } catch {}
      render();
    });
    root.querySelectorAll('[data-share]').forEach(b => b.onclick = async () => {
      const p = data.posts.find(x => x.id === b.dataset.share); if (!p) return;
      const value = `${p.author}: ${p.text}`;
      try { await navigator.clipboard.writeText(value); toast('Текст публикации скопирован'); }
      catch { window.prompt('Скопируй публикацию:', value); }
    });
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
      const p = data.posts.find(x => x.id === b.dataset.edit); if (!p) return;
      const value = prompt('Измени текст публикации:', p.text); if (value === null) return;
      try {
        const { error } = await sb().from('posts').update({ body: value.trim(), edited_at: new Date().toISOString() }).eq('id', p.id).eq('author_id', uid());
        if (error) throw error;
        await refresh(); toast('Публикация обновлена');
      } catch (e) { reportError('Не удалось изменить публикацию', e); }
    });
    root.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
      const p = data.posts.find(x => x.id === b.dataset.delete);
      if (!p || !confirm('Удалить эту публикацию?')) return;
      try {
        const { error } = await sb().from('posts').delete().eq('id', p.id).eq('author_id', uid());
        if (error) throw error;
        await refresh(); toast('Публикация удалена');
      } catch (e) { reportError('Не удалось удалить публикацию', e); }
    });
    root.querySelectorAll('[data-report]').forEach(b => b.onclick = async () => {
      const reason = prompt('Почему ты хочешь пожаловаться на публикацию?');
      if (!reason?.trim()) return;
      try {
        const { error } = await sb().from('reports').insert({ reporter_id: uid(), target_type: 'post', target_id: b.dataset.report, reason: reason.trim().slice(0, 120) });
        if (error) throw error;
        toast('Жалоба отправлена на рассмотрение.');
      } catch (e) { reportError('Не удалось отправить жалобу', e); }
    });
  };

  openComments = function(id) {
    activeCommentPost = id;
    const p = data.posts.find(x => x.id === id); if (!p) return;
    $('#commentsList').innerHTML = p.comments.length
      ? p.comments.map(c => `<div class="comment"><b>${esc(c.author)}</b>${esc(c.text)}</div>`).join('')
      : '<div class="empty">Пока нет комментариев.</div>';
    $('#commentsDialog').showModal();
  };
  $('#commentForm').onsubmit = async e => {
    e.preventDefault();
    const value = $('#commentInput').value.trim(); if (!value || !activeCommentPost) return;
    try {
      const user = await ensureRemoteUser();
      const { error } = await sb().from('comments').insert({ post_id: activeCommentPost, author_id: user.id, body: value });
      if (error) throw error;
      $('#commentInput').value = ''; await refresh(); openComments(activeCommentPost);
    } catch (err) { reportError('Не удалось добавить комментарий', err); }
  };

  $('#avatarInput').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (!f.type.startsWith('image/') || f.size > 5 * 1024 * 1024) { toast('Выбери изображение до 5 МБ'); e.target.value = ''; return; }
    avatarFile = f; toast('Фото выбрано. Нажми «Сохранить»');
  };
  $('#saveProfile').onclick = async e => {
    e.preventDefault();
    const button = $('#saveProfile');
    if (button) button.disabled = true;
    try {
      const user = await ensureRemoteUser();
      const display_name = $('#nameInput').value.trim();
      const bio = $('#bioInput').value.trim();
      if (!display_name) throw new Error('Ник не может быть пустым.');
      if (display_name.length > 40) throw new Error('Ник должен содержать не более 40 символов.');
      if (bio.length > 300) throw new Error('Описание должно содержать не более 300 символов.');
      let avatar_path;
      if (avatarFile) avatar_path = await uploadMedia('avatars', avatarFile);
      const patch = { id: user.id, display_name, bio, updated_at: new Date().toISOString() };
      if (avatar_path) patch.avatar_path = avatar_path;
      // upsert also repairs a missing profile row; id always comes from Auth UUID.
      const { error } = await sb().from('profiles').upsert(patch, { onConflict: 'id' });
      if (error) throw error;
      avatarFile = null;
      $('#profileDialog').close();
      await refresh();
      toast('Ник и профиль сохранены');
    } catch (err) {
      reportError('Не удалось сохранить ник', err);
    } finally {
      if (button) button.disabled = false;
    }
  };
  $('#postImage').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (!f.type.startsWith('image/') || f.size > 10 * 1024 * 1024) { toast('Выбери изображение до 10 МБ'); e.target.value = ''; return; }
    postImageFile = f; $('#imageName').textContent = f.name;
  };
  $('#publishPost').onclick = async () => {
    const body = $('#postText').value.trim();
    if (!body && !postImageFile) return toast('Добавь текст или фото');
    try {
      const image_path = postImageFile ? await uploadMedia('post-media', postImageFile) : null;
      const { error } = await sb().from('posts').insert({ author_id: uid(), body, image_path });
      if (error) throw error;
      $('#postText').value = ''; $('#postImage').value = ''; $('#imageName').textContent = 'До 10 МБ'; postImageFile = null;
      await refresh(); toast('Публикация добавлена!');
    } catch (err) { reportError('Не удалось опубликовать запись', err); }
  };
  $('#publishStory').onclick = async e => {
    e.preventDefault();
    const body = $('#storyText').value.trim(); if (!body) return toast('Напиши короткую историю');
    try {
      const { error } = await sb().from('stories').insert({ author_id: uid(), body });
      if (error) throw error;
      $('#storyDialog').close(); $('#storyText').value = ''; await refresh(); toast('История добавлена');
    } catch (err) { reportError('Не удалось добавить историю', err); }
  };

  // Saved posts are private to this browser/account; social content itself is server-side.
  const originalRender = render;
  render = function() {
    try { data.savedIds = JSON.parse(localStorage.getItem('newgorod-saved-v1-' + uid()) || '[]'); } catch { data.savedIds = []; }
    return originalRender();
  };
  // Keep profile dialog populated from server state.
  $('#editProfile').onclick = () => {
    $('#nameInput').value = data.name; $('#bioInput').value = data.bio;
    avatarFile = null; $('#avatarInput').value = ''; $('#profileDialog').showModal();
  };


  // Mutual friendship requests. Requires migration 202611240002_friend_requests.sql.
  let friendRows = [];
  let peopleSearchSequence = 0;
  const friendProfileCache = new Map();
  let activeConversationId = null;
  let activeChatFriendId = null;
  let chatRealtimeChannel = null;
  let chatOpenSequence = 0;
  let chatMessages = [];
  const friendCallChannels = new Map();
  let activeCall = null;
  let callPolicyWarningShown = false;
  const friendName = p => p?.display_name || 'Горожанин';
  const friendAvatar = p => publicUrl('avatars', p?.avatar_path);
  const friendPersonCard = (profile, actionMarkup = '', subtitle = '') => {
    const name = friendName(profile);
    const photo = friendAvatar(profile);
    return `<article class="people-card">${photo ? `<div class="avatar" style="background-image:url('${esc(photo)}')"></div>` : `<div class="avatar">${esc(name[0] || 'Г')}</div>`}<div class="people-info"><b>${esc(name)}</b><p>${esc(subtitle || profile.bio || 'Житель NewGorod')}</p></div><div class="people-actions">${actionMarkup}</div></article>`;
  };
  const emptyPeople = message => `<div class="empty">${esc(message)}</div>`;
  async function getFriendProfiles(ids) {
    const unique = [...new Set(ids.filter(id => id && id !== uid()))];
    const missing = unique.filter(id => !friendProfileCache.has(id));
    if (missing.length) {
      const { data: rows, error } = await sb().from('profiles')
        .select('id,username,display_name,bio,avatar_path').in('id', missing);
      if (error) throw error;
      rows.forEach(row => friendProfileCache.set(row.id, row));
    }
    return unique.map(id => friendProfileCache.get(id)).filter(Boolean);
  }
  async function loadFriendRows() {
    if (!sb()) throw new Error('Supabase не подключён.');
    await ensureRemoteUser();
    if (!uid()) {
      ['incomingRequests','outgoingRequests','friendsList'].forEach(id => { const el = $('#' + id); if (el) el.innerHTML = emptyPeople('Войди в аккаунт, чтобы пользоваться друзьями.'); });
      return;
    }
    const { data: rows, error } = await sb().from('friend_requests').select('*')
      .or(`sender_id.eq.${uid()},recipient_id.eq.${uid()}`)
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    friendRows = rows || [];
    const ids = friendRows.flatMap(row => [row.sender_id, row.recipient_id]);
    await getFriendProfiles(ids);
    syncFriendCallChannels().catch(error => {
      console.error('[NewGorod] Не удалось синхронизировать каналы звонков', error);
    });
    const incoming = friendRows.filter(row => row.status === 'pending' && row.recipient_id === uid());
    const outgoing = friendRows.filter(row => row.status === 'pending' && row.sender_id === uid());
    const friends = friendRows.filter(row => row.status === 'accepted');
    $('#incomingRequests').innerHTML = incoming.length ? incoming.map(row => {
      const profile = friendProfileCache.get(row.sender_id);
      return friendPersonCard(profile, `<button class="primary-btn" data-friend-action="accept" data-request-id="${row.id}">Принять</button><button class="danger-action" data-friend-action="reject" data-request-id="${row.id}">Отклонить</button>`, 'Хочет добавить тебя в друзья');
    }).join('') : emptyPeople('Новых заявок пока нет.');
    $('#outgoingRequests').innerHTML = outgoing.length ? outgoing.map(row => {
      const profile = friendProfileCache.get(row.recipient_id);
      return friendPersonCard(profile, `<button data-friend-action="cancel" data-request-id="${row.id}">Отменить</button>`, 'Заявка отправлена');
    }).join('') : emptyPeople('Ты пока никому не отправлял заявку.');
    $('#friendsList').innerHTML = friends.length ? friends.map(row => {
      const friendId = row.sender_id === uid() ? row.recipient_id : row.sender_id;
      const profile = friendProfileCache.get(friendId);
      return friendPersonCard(profile, `<button class="danger-action" data-friend-action="remove" data-request-id="${row.id}">Удалить</button>`, 'Уже в друзьях');
    }).join('') : emptyPeople('Здесь появятся люди, чьи заявки ты примешь.');
    const count = $('#friendCount');
    if (count) count.textContent = String(friends.length);
    renderPeopleSearch($('#peopleSearch').value);
    renderChatFriends();
  }
  async function renderPeopleSearch(query) {
    const root = $('#peopleResults');
    const q = String(query || '').trim();
    const seq = ++peopleSearchSequence;
    if (!q) { root.innerHTML = emptyPeople('Введи имя, чтобы найти жителей NewGorod.'); return; }
    if (q.length < 2) { root.innerHTML = emptyPeople('Введи хотя бы 2 символа.'); return; }
    root.innerHTML = emptyPeople('Ищем жителей…');
    try {
      if (!sb()) throw new Error('Supabase не подключён.');
      await ensureRemoteUser();
      if (!uid()) throw new Error('Сначала войди в аккаунт.');
      const safeQuery = q.replace(/[%,_]/g, ' ').trim();
      let profileQuery = sb().from('profiles')
        .select('id,username,display_name,bio,avatar_path')
        .ilike('display_name', `%${safeQuery}%`);
      if (uid()) profileQuery = profileQuery.neq('id', uid());
      const { data: profiles, error } = await profileQuery
        .order('display_name', { ascending: true }).limit(30);
      if (error) throw error;
      if (seq !== peopleSearchSequence) return;
      (profiles || []).forEach(profile => friendProfileCache.set(profile.id, profile));
      if (!profiles?.length) { root.innerHTML = emptyPeople('По этому имени никого не нашли.'); return; }
      root.innerHTML = profiles.map(profile => {
        const relation = friendRows.find(row =>
          (row.sender_id === uid() && row.recipient_id === profile.id) ||
          (row.sender_id === profile.id && row.recipient_id === uid())
        );
        let actions = '';
        if (!relation) actions = `<button class="primary-btn" data-friend-action="send" data-user-id="${profile.id}">Добавить</button>`;
        else if (relation.status === 'accepted') actions = '<button disabled>✓ Вы друзья</button>';
        else if (relation.status === 'pending' && relation.sender_id === uid()) actions = '<button disabled>Заявка отправлена</button>';
        else if (relation.status === 'pending') actions = `<button class="primary-btn" data-friend-action="accept" data-request-id="${relation.id}">Принять заявку</button>`;
        else actions = `<button class="primary-btn" data-friend-action="send" data-user-id="${profile.id}">Добавить снова</button>`;
        return friendPersonCard(profile, actions, profile.bio || 'Житель NewGorod');
      }).join('');
    } catch (error) {
      if (seq === peopleSearchSequence) root.innerHTML = emptyPeople(`Не удалось найти жителей: ${error.message || 'ошибка сервера'}`);
    }
  }
  async function handleFriendAction(button) {
    const action = button.dataset.friendAction;
    const requestId = button.dataset.requestId;
    const targetId = button.dataset.userId;
    button.disabled = true;
    try {
      const user = await ensureRemoteUser();
      const myId = user.id;
      if (!myId) throw new Error('Сначала войди в аккаунт.');

      if (action === 'send') {
        if (!targetId || targetId === myId) throw new Error('Некорректный пользователь.');
        // Read both directions first so repeated clicks and reciprocal requests
        // never attempt to create a second active pair.
        const { data: pairRows, error: pairError } = await sb().from('friend_requests')
          .select('*')
          .or(`and(sender_id.eq.${myId},recipient_id.eq.${targetId}),and(sender_id.eq.${targetId},recipient_id.eq.${myId})`)
          .order('created_at', { ascending: false });
        if (pairError) throw pairError;
        const active = (pairRows || []).find(row => row.status === 'accepted' || row.status === 'pending');
        if (active?.status === 'accepted') {
          toast('Вы уже друзья.');
        } else if (active?.status === 'pending' && active.sender_id === myId) {
          toast('Заявка уже отправлена.');
        } else if (active?.status === 'pending' && active.recipient_id === myId) {
          const { data: updated, error } = await sb().rpc('respond_to_friend_request', {
            p_request_id: active.id,
            p_action: 'accept'
          });
          if (error) throw error;
          if (updated !== 'accepted') throw new Error('Встречная заявка не обновилась. Обнови список.');
          notifyPush('friend_accepted', active.id);
          toast('Встречная заявка принята. Теперь вы друзья!');
        } else {
          // Rejected rows are outside the active-pair index; remove old history
          // for this pair before creating a fresh pending request.
          const rejectedIds = (pairRows || []).filter(row => row.status === 'rejected').map(row => row.id);
          if (rejectedIds.length) {
            const { error: deleteError } = await sb().from('friend_requests').delete().in('id', rejectedIds);
            if (deleteError) throw deleteError;
          }
          const { data: request, error } = await sb().from('friend_requests')
            .insert({ sender_id: myId, recipient_id: targetId })
            .select('id')
            .single();
          if (error) {
            // A concurrent/reciprocal click may have created the pair after our read.
            if (error.code === '23505') {
              await loadFriendRows();
              toast('Заявка или дружба уже существует. Список обновлён.');
              return;
            }
            throw error;
          }
          notifyPush('friend_request', request.id);
          toast('Заявка в друзья отправлена.');
        }
      } else if (action === 'accept' || action === 'reject') {
        if (!requestId) throw new Error('Не найдена заявка. Обнови список.');
        const { data: current, error: readError } = await sb().from('friend_requests')
          .select('id,sender_id,recipient_id,status').eq('id', requestId).maybeSingle();
        if (readError) throw readError;
        if (!current) throw new Error('Заявка уже удалена. Обнови список.');
        if (current.recipient_id !== myId) throw new Error('Только получатель может обработать эту заявку.');
        if (current.status === 'accepted') {
          toast('Вы уже друзья.');
        } else if (current.status !== 'pending') {
          throw new Error('Эта заявка уже обработана. Обнови список.');
        } else {
          const { data: updated, error } = await sb().rpc('respond_to_friend_request', {
            p_request_id: requestId,
            p_action: action
          });
          if (error) throw error;
          if (updated !== (action === 'accept' ? 'accepted' : 'rejected'))
            throw new Error('Заявка не обновилась. Обнови список и попробуй ещё раз.');
          if (action === 'accept') notifyPush('friend_accepted', requestId);
          toast(action === 'accept' ? 'Теперь вы друзья!' : 'Заявка отклонена.');
        }
      } else if (action === 'cancel' || action === 'remove') {
        if (!requestId) throw new Error('Не найдена запись. Обнови список.');
        const { data: current, error: readError } = await sb().from('friend_requests')
          .select('id,sender_id,recipient_id,status').eq('id', requestId).maybeSingle();
        if (readError) throw readError;
        if (!current) {
          toast('Запись уже удалена.');
        } else {
          if (current.sender_id !== myId && current.recipient_id !== myId)
            throw new Error('Нет доступа к этой записи.');
          const { error } = await sb().from('friend_requests').delete().eq('id', requestId);
          if (error) throw error;
          toast(action === 'remove' ? 'Пользователь удалён из друзей.' : 'Заявка отменена.');
        }
      }

      await loadFriendRows();
    } catch (error) {
      reportError('Не удалось выполнить действие с друзьями', error);
      button.disabled = false;
    }
  }
  function renderChatFriends() {
    const root = $('#chatFriends');
    if (!root) return;
    if (!uid()) {
      root.innerHTML = emptyPeople('Войди в аккаунт, чтобы открыть чаты.');
      return;
    }
    const friendIds = [...new Set(friendRows
      .filter(row => row.status === 'accepted')
      .map(row => row.sender_id === uid() ? row.recipient_id : row.sender_id))];
    root.innerHTML = friendIds.length
      ? friendIds.map(id => {
        const profile = friendProfileCache.get(id);
        if (!profile) return '';
        return friendPersonCard(profile,
          `<button class="primary-btn" data-chat-user="${esc(id)}">${id === activeChatFriendId ? 'Открыта' : 'Написать'}</button>`,
          'Друг');
      }).join('')
      : emptyPeople('Пока нет друзей. Прими заявку или найди жителя в разделе «Друзья».');
  }
  function friendCallTopic(peerId) {
    return `friend-call:${[uid(), peerId].sort().join(':')}`;
  }
  function ensureFriendCallChannel(peerId) {
    if (!uid() || !peerId || peerId === uid()) throw new Error('Некорректный собеседник для звонка.');
    const existing = friendCallChannels.get(peerId);
    if (existing) return existing;
    let resolveReady;
    let readyResolved = false;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const markReady = value => {
      if (readyResolved) return;
      readyResolved = true;
      resolveReady(value);
    };
    const entry = { channel: null, ready, state: 'joining' };
    entry.channel = sb().channel(friendCallTopic(peerId), { config: { private: true } })
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        handleCallSignal(peerId, payload).catch(error => reportError('Ошибка сигнала звонка', error));
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          entry.state = 'ready';
          markReady(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          entry.state = 'error';
          markReady(false);
          if (!callPolicyWarningShown) {
            callPolicyWarningShown = true;
            toast('Звонки не подключены. Сначала выполни SQL из friend_calls.sql.');
          }
        }
      });
    friendCallChannels.set(peerId, entry);
    return entry;
  }
  async function syncFriendCallChannels() {
    if (!uid()) return;
    const peerIds = new Set(friendRows
      .filter(row => row.status === 'accepted')
      .map(row => row.sender_id === uid() ? row.recipient_id : row.sender_id));
    for (const [peerId, entry] of friendCallChannels) {
      if (!peerIds.has(peerId)) {
        friendCallChannels.delete(peerId);
        await sb().removeChannel(entry.channel);
        if (activeCall?.peerId === peerId) finishCall(false);
      }
    }
    peerIds.forEach(peerId => ensureFriendCallChannel(peerId));
  }
  async function closeFriendCallChannels() {
    const entries = [...friendCallChannels.values()];
    friendCallChannels.clear();
    await Promise.all(entries.map(entry => sb()?.removeChannel(entry.channel)));
  }
  function updateCallLaunchButtons() {
    const disabled = !activeConversationId || !activeChatFriendId || Boolean(activeCall);
    $('#startAudioCall').disabled = disabled;
    $('#startVideoCall').disabled = disabled;
  }
  function setCallDialog(call, incoming, status) {
    $('#callDialogTitle').textContent = friendName(friendProfileCache.get(call.peerId));
    $('#callStatus').textContent = status;
    $('#callStage').classList.toggle('audio-only', call.mode === 'audio');
    $('#callAvatar').textContent = friendName(friendProfileCache.get(call.peerId))[0] || '☎';
    $('#toggleCallMute').textContent = 'Выключить микрофон';
    $('#toggleCallVideo').textContent = 'Выключить камеру';
    $('#incomingCallActions').classList.toggle('hidden', !incoming);
    $('#activeCallActions').classList.toggle('hidden', incoming);
    $('#toggleCallVideo').classList.toggle('hidden', call.mode !== 'video');
    if (!$('#callDialog').open) $('#callDialog').showModal();
  }
  async function sendCallSignal(peerId, signal) {
    const entry = ensureFriendCallChannel(peerId);
    if (!await entry.ready) throw new Error('Не удалось подключиться к каналу звонка. Проверь настройки Realtime.');
    const result = await entry.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { ...signal, from: uid(), to: peerId }
    });
    if (result !== 'ok') throw new Error(`Не удалось отправить сигнал звонка (${result}).`);
  }
  function flushLocalCallIce(call) {
    call.signalReady = true;
    const candidates = call.pendingLocalIce.splice(0);
    return candidates.reduce((queue, candidate) => queue.then(() =>
      sendCallSignal(call.peerId, { type: 'ice', callId: call.callId, candidate })
    ), Promise.resolve());
  }
  async function flushRemoteCallIce(call) {
    if (!call.pc?.remoteDescription) return;
    while (call.pendingRemoteIce.length) {
      await call.pc.addIceCandidate(new RTCIceCandidate(call.pendingRemoteIce.shift()));
    }
  }
  function createCallPeerConnection(call) {
    if (!window.RTCPeerConnection) throw new Error('Браузер не поддерживает WebRTC-звонки.');
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    call.pc = pc;
    pc.onicecandidate = event => {
      if (!event.candidate || activeCall !== call) return;
      const candidate = event.candidate.toJSON();
      if (!call.signalReady) {
        call.pendingLocalIce.push(candidate);
        return;
      }
      sendCallSignal(call.peerId, { type: 'ice', callId: call.callId, candidate })
        .catch(error => reportError('Не удалось передать данные звонка', error));
    };
    pc.ontrack = event => {
      if (activeCall !== call) return;
      const remoteVideo = $('#remoteCallVideo');
      if (event.streams?.[0]) remoteVideo.srcObject = event.streams[0];
      else {
        call.remoteStream ||= new MediaStream();
        call.remoteStream.addTrack(event.track);
        remoteVideo.srcObject = call.remoteStream;
      }
      if (call.mode === 'video') $('#callAvatar').hidden = true;
      remoteVideo.play().catch(() => {
        $('#callStatus').textContent = 'Нажми на звонок, чтобы включить звук.';
      });
    };
    pc.onconnectionstatechange = () => {
      if (activeCall !== call) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(call.timeout);
        $('#callStatus').textContent = 'Звонок активен.';
      } else if (pc.connectionState === 'connecting') {
        $('#callStatus').textContent = 'Соединяемся…';
      } else if (pc.connectionState === 'failed') {
        $('#callStatus').textContent = 'Связь не установлена. Для некоторых сетей нужен TURN-сервер.';
      } else if (pc.connectionState === 'disconnected') {
        $('#callStatus').textContent = 'Связь прервалась, пытаемся восстановить…';
      }
    };
    return pc;
  }
  function finishCall(notifyPeer = true, signalType = 'end') {
    const call = activeCall;
    if (!call) return;
    activeCall = null;
    clearTimeout(call.timeout);
    if (notifyPeer) {
      sendCallSignal(call.peerId, { type: signalType, callId: call.callId })
        .catch(error => console.error('[NewGorod] Не удалось завершить звонок у собеседника', error));
    }
    call.localStream?.getTracks().forEach(track => track.stop());
    call.pc?.close();
    $('#localCallVideo').srcObject = null;
    $('#remoteCallVideo').srcObject = null;
    $('#callAvatar').hidden = false;
    if ($('#callDialog').open) $('#callDialog').close();
    updateCallLaunchButtons();
  }
  function startCallTimeout(call) {
    clearTimeout(call.timeout);
    call.timeout = setTimeout(() => {
      if (activeCall !== call) return;
      const signalType = call.role === 'callee' ? 'missed' : 'cancel';
      finishCall(true, signalType);
      toast('На звонок не ответили.');
    }, 45000);
  }
  async function startFriendCall(mode) {
    const peerId = activeChatFriendId;
    if (!peerId || activeCall) return;
    let call;
    try {
      await ensureRemoteUser();
      const isFriend = friendRows.some(row => row.status === 'accepted' &&
        ((row.sender_id === uid() && row.recipient_id === peerId) ||
         (row.recipient_id === uid() && row.sender_id === peerId)));
      if (!isFriend) throw new Error('Звонить можно только подтверждённым друзьям.');
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
        throw new Error('Для звонков открой сайт по HTTPS и разреши доступ к микрофону/камере.');
      const channel = ensureFriendCallChannel(peerId);
      if (!await channel.ready) throw new Error('Канал звонка недоступен. Проверь friend_calls.sql в Supabase.');
      call = {
        callId: crypto.randomUUID(),
        peerId,
        mode,
        role: 'caller',
        pc: null,
        localStream: null,
        pendingLocalIce: [],
        pendingRemoteIce: [],
        signalReady: false
      };
      activeCall = call;
      updateCallLaunchButtons();
      setCallDialog(call, false, 'Подготавливаем звонок…');
      call.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: mode === 'video'
      });
      if (activeCall !== call) {
        call.localStream.getTracks().forEach(track => track.stop());
        return;
      }
      $('#localCallVideo').srcObject = call.localStream;
      if (mode === 'video') $('#localCallVideo').play().catch(() => {});
      const pc = createCallPeerConnection(call);
      call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendCallSignal(peerId, {
        type: 'offer',
        callId: call.callId,
        mode,
        sdp: pc.localDescription.toJSON()
      });
      await flushLocalCallIce(call);
      setCallDialog(call, false, 'Звоним…');
      startCallTimeout(call);
    } catch (error) {
      if (activeCall === call) finishCall(false);
      reportError('Не удалось начать звонок', error);
    }
  }
  async function acceptFriendCall() {
    const call = activeCall;
    if (!call || call.role !== 'callee') return;
    $('#acceptCall').disabled = true;
    try {
      await ensureRemoteUser();
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
        throw new Error('Для звонков открой сайт по HTTPS и разреши доступ к микрофону/камере.');
      call.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.mode === 'video'
      });
      if (activeCall !== call) {
        call.localStream.getTracks().forEach(track => track.stop());
        return;
      }
      $('#localCallVideo').srcObject = call.localStream;
      if (call.mode === 'video') $('#localCallVideo').play().catch(() => {});
      const pc = createCallPeerConnection(call);
      call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
      await pc.setRemoteDescription(call.offer);
      await flushRemoteCallIce(call);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendCallSignal(call.peerId, {
        type: 'answer',
        callId: call.callId,
        sdp: pc.localDescription.toJSON()
      });
      await flushLocalCallIce(call);
      setCallDialog(call, false, 'Соединяемся…');
      startCallTimeout(call);
    } catch (error) {
      $('#callStatus').textContent = error.message || 'Не удалось ответить на звонок.';
      if (activeCall === call) {
        call.localStream?.getTracks().forEach(track => track.stop());
        call.localStream = null;
        call.pc?.close();
        call.pc = null;
        $('#localCallVideo').srcObject = null;
      }
      reportError('Не удалось ответить на звонок', error);
    } finally {
      if (activeCall === call) $('#acceptCall').disabled = false;
    }
  }
  async function handleCallSignal(peerId, payload) {
    if (!payload || payload.from !== peerId || payload.to !== uid() || !payload.callId) return;
    if (payload.type === 'offer') {
      if (activeCall) {
        if (activeCall.callId !== payload.callId)
          await sendCallSignal(peerId, { type: 'busy', callId: payload.callId });
        return;
      }
      if (!['audio', 'video'].includes(payload.mode) || !payload.sdp) return;
      const call = {
        callId: payload.callId,
        peerId,
        mode: payload.mode,
        role: 'callee',
        offer: payload.sdp,
        pc: null,
        localStream: null,
        pendingLocalIce: [],
        pendingRemoteIce: [],
        signalReady: false
      };
      activeCall = call;
      updateCallLaunchButtons();
      setCallDialog(call, true, `Входящий ${call.mode === 'video' ? 'видеозвонок' : 'аудиозвонок'}`);
      startCallTimeout(call);
      return;
    }
    const call = activeCall;
    if (!call || call.peerId !== peerId || call.callId !== payload.callId) return;
    if (payload.type === 'answer' && call.role === 'caller' && call.pc) {
      await call.pc.setRemoteDescription(payload.sdp);
      await flushRemoteCallIce(call);
      $('#callStatus').textContent = 'Соединяемся…';
      return;
    }
    if (payload.type === 'ice' && payload.candidate) {
      if (call.pc?.remoteDescription)
        await call.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      else call.pendingRemoteIce.push(payload.candidate);
      return;
    }
    if (['decline', 'cancel', 'end', 'missed', 'busy'].includes(payload.type)) {
      if (payload.type === 'decline') toast('Друг отклонил звонок.');
      else if (payload.type === 'missed') toast('Друг не ответил на звонок.');
      else if (payload.type === 'busy') toast('Друг сейчас занят.');
      else toast('Звонок завершён.');
      finishCall(false);
    }
  }
  function toggleCallMute() {
    const tracks = activeCall?.localStream?.getAudioTracks() || [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach(track => { track.enabled = enabled; });
    $('#toggleCallMute').textContent = enabled ? 'Выключить микрофон' : 'Включить микрофон';
  }
  function toggleCallVideo() {
    const tracks = activeCall?.localStream?.getVideoTracks() || [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach(track => { track.enabled = enabled; });
    $('#toggleCallVideo').textContent = enabled ? 'Выключить камеру' : 'Включить камеру';
  }
  $('#startAudioCall').addEventListener('click', () => startFriendCall('audio'));
  $('#startVideoCall').addEventListener('click', () => startFriendCall('video'));
  $('#acceptCall').addEventListener('click', acceptFriendCall);
  $('#declineCall').addEventListener('click', () => finishCall(true, 'decline'));
  $('#endCall').addEventListener('click', () => {
    const signalType = activeCall?.role === 'callee' && !activeCall.pc ? 'decline'
      : activeCall?.role === 'caller' && !activeCall.pc?.remoteDescription ? 'cancel' : 'end';
    finishCall(true, signalType);
  });
  $('#closeCallDialog').addEventListener('click', () => {
    const signalType = activeCall?.role === 'callee' && !activeCall.pc ? 'decline'
      : activeCall?.role === 'caller' && !activeCall.pc?.remoteDescription ? 'cancel' : 'end';
    finishCall(true, signalType);
  });
  $('#toggleCallMute').addEventListener('click', toggleCallMute);
  $('#toggleCallVideo').addEventListener('click', toggleCallVideo);
  $('#callDialog').addEventListener('cancel', event => {
    event.preventDefault();
    const signalType = activeCall?.role === 'callee' && !activeCall.pc ? 'decline'
      : activeCall?.role === 'caller' && !activeCall.pc?.remoteDescription ? 'cancel' : 'end';
    finishCall(true, signalType);
  });
  async function closeChatSubscription() {
    if (chatRealtimeChannel && sb()) await sb().removeChannel(chatRealtimeChannel);
    chatRealtimeChannel = null;
  }
  function renderDirectChatMessages() {
    const root = $('#directChatMessages');
    if (!root) return;
    root.innerHTML = chatMessages.length ? chatMessages.map(message => {
      const own = message.sender_id === uid();
      const time = new Date(message.created_at).toLocaleString();
      return `<article class="direct-message${own ? ' own' : ''}"><div class="direct-message-meta">${own ? 'Ты' : esc(friendName(friendProfileCache.get(activeChatFriendId)))} · ${esc(time)}</div><p>${esc(message.body)}</p></article>`;
    }).join('') : emptyPeople('Сообщений пока нет. Напиши первым!');
    root.scrollTop = root.scrollHeight;
  }
  async function openDirectChat(friendId) {
    const sequence = ++chatOpenSequence;
    activeConversationId = null;
    updateCallLaunchButtons();
    activeChatFriendId = friendId;
    chatMessages = [];
    $('#directChatName').textContent = friendName(friendProfileCache.get(friendId));
    $('#directChatStatus').textContent = 'Открываем переписку…';
    $('#directChatInput').disabled = true;
    $('#sendDirectMessage').disabled = true;
    $('#directChatMessages').innerHTML = emptyPeople('Загрузка переписки…');
    renderChatFriends();
    try {
      await closeChatSubscription();
      const { data: conversationId, error: openError } = await sb().rpc('open_friend_conversation', {
        p_friend_id: friendId
      });
      if (openError) throw openError;
      if (sequence !== chatOpenSequence) return;
      if (typeof conversationId !== 'string' || !conversationId) throw new Error('Сервер не вернул переписку.');
      const { data: messages, error: messagesError } = await sb().from('messages')
        .select('id,sender_id,body,created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (messagesError) throw messagesError;
      if (sequence !== chatOpenSequence) return;
      activeConversationId = conversationId;
      updateCallLaunchButtons();
      chatMessages = messages || [];
      renderDirectChatMessages();
      $('#directChatStatus').textContent = 'Сообщения обновляются в реальном времени.';
      $('#directChatInput').disabled = false;
      $('#sendDirectMessage').disabled = false;
      chatRealtimeChannel = sb().channel(`friend-chat-${conversationId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`
        }, payload => {
          if (sequence !== chatOpenSequence || chatMessages.some(message => message.id === payload.new.id)) return;
          chatMessages.push(payload.new);
          renderDirectChatMessages();
        })
        .subscribe(status => {
          if (sequence !== chatOpenSequence) return;
          if (status === 'SUBSCRIBED') {
            $('#directChatStatus').textContent = 'Онлайн — сообщения обновляются сразу.';
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            $('#directChatStatus').textContent = 'Нет связи в реальном времени. Переоткрой чат, чтобы обновить сообщения.';
            toast('Не удалось подключить обновление чата. Обнови страницу.');
          }
        });
    } catch (error) {
      if (sequence !== chatOpenSequence) return;
      $('#directChatStatus').textContent = 'Не удалось открыть переписку.';
      $('#directChatMessages').innerHTML = emptyPeople(error.message || 'Ошибка сервера.');
      reportError('Не удалось открыть чат', error);
    }
  }
  $('#chatFriends').addEventListener('click', event => {
    const button = event.target.closest('[data-chat-user]');
    if (button && !button.disabled) openDirectChat(button.dataset.chatUser);
  });
  $('#directChatForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = $('#directChatInput').value.trim();
    if (!body || !activeConversationId || !uid()) return;
    const button = $('#sendDirectMessage');
    button.disabled = true;
    try {
      const { data: message, error } = await sb().from('messages').insert({
        conversation_id: activeConversationId,
        sender_id: uid(),
        body
      }).select('id,sender_id,body,created_at').single();
      if (error) throw error;
      notifyPush('message', message.id);
      if (!chatMessages.some(item => item.id === message.id)) {
        chatMessages.push(message);
        renderDirectChatMessages();
      }
      $('#directChatInput').value = '';
    } catch (error) {
      reportError('Не удалось отправить сообщение', error);
    } finally {
      button.disabled = !activeConversationId;
    }
  });
  async function loadChatFriends() {
    try {
      await loadFriendRows();
      renderChatFriends();
    } catch (error) {
      $('#chatFriends').innerHTML = emptyPeople('Не удалось загрузить друзей.');
      reportError('Не удалось загрузить чаты', error);
    }
  }
  $('#peopleSearch').addEventListener('input', event => renderPeopleSearch(event.target.value));
  $('#refreshFriends').addEventListener('click', async () => {
    try { await loadFriendRows(); toast('Список друзей обновлён.'); }
    catch (error) { reportError('Не удалось обновить список друзей', error); }
  });
  $('#friendsView').addEventListener('click', event => {
    const button = event.target.closest('[data-friend-action]');
    if (button && !button.disabled) handleFriendAction(button);
  });
  document.querySelector('[data-view="friendsView"]').addEventListener('click', () => {
    loadFriendRows().catch(error => reportError('Не удалось загрузить друзей', error));
  });
  document.querySelector('[data-view="messagesView"]').addEventListener('click', loadChatFriends);
  $('#openMessages').addEventListener('click', loadChatFriends);
  $('#enablePushNotifications').addEventListener('click', async () => {
    const button = $('#enablePushNotifications');
    button.disabled = true;
    try {
      await enablePushNotifications();
    } catch (error) {
      reportError('Не удалось включить уведомления', error);
    } finally {
      button.disabled = false;
      refreshPushSettings().catch(error => {
        console.error('[NewGorod] Не удалось проверить push-подписку', error);
      });
    }
  });
  $('#disablePushNotifications').addEventListener('click', async () => {
    const button = $('#disablePushNotifications');
    button.disabled = true;
    try {
      await disablePushNotifications();
    } catch (error) {
      reportError('Не удалось выключить уведомления', error);
    } finally {
      button.disabled = false;
      refreshPushSettings().catch(error => {
        console.error('[NewGorod] Не удалось проверить push-подписку', error);
      });
    }
  });
  function openPushTarget() {
    const params = new URLSearchParams(location.search);
    const view = params.get('view');
    if (!['messagesView', 'friendsView'].includes(view)) return;
    switchView(view);
    if (view === 'messagesView') {
      const friendId = params.get('friend');
      const isFriend = friendRows.some(row => row.status === 'accepted' &&
        ((row.sender_id === uid() && row.recipient_id === friendId)
          || (row.recipient_id === uid() && row.sender_id === friendId)));
      if (friendId && isFriend) openDirectChat(friendId);
    }
    history.replaceState(null, '', location.pathname);
  }
  window.addEventListener('newgorod-auth', event => {
    remoteUser = event.detail?.user || null;
    refreshPushSettings().catch(error => {
      console.error('[NewGorod] Не удалось проверить push-подписку', error);
    });
    if (activeCall) finishCall(false);
    closeFriendCallChannels().catch(error => reportError('Не удалось закрыть каналы звонков', error));
    friendRows = [];
    friendProfileCache.clear();
    chatOpenSequence++;
    activeConversationId = null;
    activeChatFriendId = null;
    chatMessages = [];
    closeChatSubscription().catch(error => reportError('Не удалось закрыть старый чат', error));
    $('#directChatName').textContent = 'Выбери друга';
    $('#directChatStatus').textContent = 'Открой переписку из списка друзей.';
    $('#directChatInput').disabled = true;
    $('#sendDirectMessage').disabled = true;
    updateCallLaunchButtons();
    $('#directChatMessages').innerHTML = emptyPeople('Здесь появятся сообщения.');
    renderChatFriends();
    if (remoteUser) {
      loadFriendRows()
        .then(openPushTarget)
        .catch(error => reportError('Не удалось загрузить друзей', error));
    }
    else {
      ['incomingRequests','outgoingRequests','friendsList'].forEach(id => { const el = $('#' + id); if (el) el.innerHTML = emptyPeople('Войди в аккаунт, чтобы пользоваться друзьями.'); });
      $('#peopleResults').innerHTML = emptyPeople('Войди в аккаунт, чтобы искать жителей.');
      if ($('#friendCount')) $('#friendCount').textContent = '0';
    }
  });

  async function restoreInitialSession() {
    if (!sb()) return;
    const { data: sessionData, error } = await sb().auth.getUser();
    if (error) throw error;
    if (sessionData?.user && uid() !== sessionData.user.id) {
      window.dispatchEvent(new CustomEvent('newgorod-auth', { detail: { user: sessionData.user } }));
    }
  }
  restoreInitialSession().catch(error => reportError('Не удалось восстановить сессию', error));

})();
