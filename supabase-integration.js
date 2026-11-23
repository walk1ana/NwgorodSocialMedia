/* NewGorod: Supabase-backed social features. Loaded after app.js. */
(() => {
  let remoteUser = null;
  let avatarFile = null;
  let postImageFile = null;
  const sb = () => (typeof authClient !== 'undefined' ? authClient : null);
  const uid = () => remoteUser?.id || null;
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
    try {
      let avatar_path;
      if (avatarFile) avatar_path = await uploadMedia('avatars', avatarFile);
      const patch = { display_name: $('#nameInput').value.trim() || 'Горожанин', bio: $('#bioInput').value.trim() };
      if (avatar_path) patch.avatar_path = avatar_path;
      const { error } = await sb().from('profiles').update(patch).eq('id', uid());
      if (error) throw error;
      avatarFile = null; $('#profileDialog').close(); await refresh(); toast('Профиль сохранён');
    } catch (err) { reportError('Не удалось сохранить профиль', err); }
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
})();
