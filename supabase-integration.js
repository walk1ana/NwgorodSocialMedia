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
      if (!post || !uid()) return;
      try {
        if (post.liked) {
          const { error } = await sb().from('likes').delete().eq('post_id', postId).eq('user_id', uid());
          if (error) throw error;
        } else {
          const { error } = await sb().from('likes').insert({ post_id: postId, user_id: uid() });
          if (error) throw error;
        }
        await refresh();
      } catch (e) { reportError('Не удалось изменить отметку «Нравится»', e); }
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
      const { error } = await sb().from('comments').insert({ post_id: activeCommentPost, author_id: uid(), body: value });
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
      await ensureRemoteUser();
      if (!uid()) throw new Error('Сначала войди в аккаунт.');
      if (action === 'send') {
        const { error } = await sb().from('friend_requests').insert({ sender_id: uid(), recipient_id: targetId });
        if (error) throw error;
        toast('Заявка в друзья отправлена.');
      } else if (action === 'accept' || action === 'reject') {
        const { error } = await sb().from('friend_requests').update({ status: action === 'accept' ? 'accepted' : 'rejected' })
          .eq('id', requestId).eq('recipient_id', uid()).eq('status', 'pending');
        if (error) throw error;
        toast(action === 'accept' ? 'Теперь вы друзья!' : 'Заявка отклонена.');
      } else if (action === 'cancel' || action === 'remove') {
        const { error } = await sb().from('friend_requests').delete().eq('id', requestId);
        if (error) throw error;
        toast(action === 'remove' ? 'Пользователь удалён из друзей.' : 'Заявка отменена.');
      }
      await loadFriendRows();
    } catch (error) {
      reportError('Не удалось выполнить действие с друзьями', error);
      button.disabled = false;
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
  window.addEventListener('newgorod-auth', event => {
    remoteUser = event.detail?.user || null;
    friendRows = [];
    friendProfileCache.clear();
    if (remoteUser) loadFriendRows().catch(error => reportError('Не удалось загрузить друзей', error));
    else {
      ['incomingRequests','outgoingRequests','friendsList'].forEach(id => { const el = $('#' + id); if (el) el.innerHTML = emptyPeople('Войди в аккаунт, чтобы пользоваться друзьями.'); });
      $('#peopleResults').innerHTML = emptyPeople('Войди в аккаунт, чтобы искать жителей.');
      if ($('#friendCount')) $('#friendCount').textContent = '0';
    }
  });

})();
