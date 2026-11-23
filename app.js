const $ = s => document.querySelector(s);
let storeKey = "newgorod-demo-v1";
let signedInUser = null;
const starterPosts = [
 {id:1,author:"Мила",initial:"М",time:"12 минут назад",text:"Нашла маленькую кофейню во дворе — там невероятно уютно. Иногда лучшие места совсем рядом ☕",likes:12,liked:false,comments:[{author:"Артём",text:"Добавила в список мест!"}],image:"",following:false},
 {id:2,author:"Артём",initial:"А",time:"38 минут назад",text:"Идея на выходные: устроить обмен книгами в городском парке. Кто бы присоединился? 📚",likes:8,liked:false,comments:[],image:"",following:false}
];
let data = load();
let activeCommentPost = null;
let pendingImage = "";
let activeTag = "";
let feedSort = "new";
let pendingAvatar = null;
function load(){try{const saved=JSON.parse(localStorage.getItem(storeKey));const base=saved||{posts:starterPosts,stories:[{name:"Мила",initial:"М"},{name:"Артём",initial:"А"},{name:"Лена",initial:"Л"}],name:"Горожанин",bio:"Исследую свой город и делюсь моментами.",following:[]};base.posts=Array.isArray(base.posts)?base.posts:starterPosts;base.stories=Array.isArray(base.stories)?base.stories:[];base.following=Array.isArray(base.following)?base.following:[];base.savedIds=Array.isArray(base.savedIds)?base.savedIds:[];base.avatar=base.avatar||"";return base}catch(e){return {posts:starterPosts,stories:[],name:"Горожанин",bio:"Исследую свой город и делюсь моментами.",following:[],savedIds:[],avatar:""}}}
function save(){try{localStorage.setItem(storeKey,JSON.stringify(data))}catch(e){toast("Память браузера заполнена. Удали часть фото или публикаций.")}}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove("show"),2300)}
function renderStories(){$("#stories").innerHTML=`<button class="story add" id="storyAdd"><div class="story-ring"><span>＋</span></div><b>Моя</b></button>`+data.stories.map(s=>`<button class="story" data-story="${esc(s.name)}"><div class="story-ring"><span>${esc(s.initial||s.name[0]||"N")}</span></div><b>${esc(s.name)}</b></button>`).join("");$("#storyAdd").onclick=()=>$("#storyDialog").showModal();document.querySelectorAll("[data-story]").forEach(b=>b.onclick=()=>toast("Истории пока демонстрационные."))}
function avatarHTML(name,initial,photo="",extra=""){const style=photo?` style="background-image:url('${photo}')"`:"";return `<div class="avatar ${extra} ${photo?"has-photo":""}"${style}>${photo?"":esc(initial||name?.[0]||"Я")}</div>`}
function postHTML(p){const own=p.author===data.name;const saved=data.savedIds.includes(p.id);return `<article class="card post-card"><div class="post-head">${avatarHTML(p.author,p.initial,p.author===data.name?data.avatar:(p.avatar||""))}<div><div class="post-author">${esc(p.author)}</div><div class="post-time">${esc(p.time)}</div></div>${own?`<div class="post-owner-tools"><button data-edit="${p.id}" title="Редактировать">✎</button><button data-delete="${p.id}" title="Удалить">×</button></div>`:""}<button class="more-btn" data-report="${p.id}" aria-label="Пожаловаться">···</button></div><p class="post-text">${esc(p.text)}</p>${p.image?`<img class="post-image" src="${p.image}" alt="Фото публикации">`:""}<div class="post-actions"><button class="action-btn ${p.liked?"liked":""}" data-like="${p.id}">${p.liked?"♥":"♡"} ${p.likes}</button><button class="action-btn" data-comments="${p.id}">◯ ${p.comments.length} комментариев</button><button class="action-btn ${saved?"saved":""}" data-save="${p.id}">${saved?"★ В избранном":"☆ Сохранить"}</button><button class="action-btn" data-share="${p.id}">↗ Поделиться</button><button class="action-btn" data-follow="${esc(p.author)}">${data.following.includes(p.author)?"✓ Вы подписаны":"+ Подписаться"}</button></div></article>`}
function wirePosts(root=document){root.querySelectorAll("[data-like]").forEach(b=>b.onclick=()=>{const p=data.posts.find(x=>x.id==b.dataset.like);if(!p)return;p.liked=!p.liked;p.likes=Math.max(0,p.likes+(p.liked?1:-1));save();render()});root.querySelectorAll("[data-comments]").forEach(b=>b.onclick=()=>openComments(+b.dataset.comments));root.querySelectorAll("[data-follow]").forEach(b=>b.onclick=()=>{const n=b.dataset.follow;if(data.following.includes(n))data.following=data.following.filter(x=>x!==n);else data.following.push(n);save();render();toast(data.following.includes(n)?"Подписка добавлена":"Подписка отменена")});root.querySelectorAll("[data-save]").forEach(b=>b.onclick=()=>{const id=+b.dataset.save;data.savedIds.includes(id)?data.savedIds=data.savedIds.filter(x=>x!==id):data.savedIds.push(id);save();render();toast(data.savedIds.includes(id)?"Добавлено в избранное":"Удалено из избранного")});root.querySelectorAll("[data-share]").forEach(b=>b.onclick=async()=>{const p=data.posts.find(x=>x.id==b.dataset.share);if(!p)return;const text=`${p.author}: ${p.text}`;try{await navigator.clipboard.writeText(text);toast("Текст публикации скопирован")}catch{window.prompt("Скопируй публикацию:",text)}});root.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>{const p=data.posts.find(x=>x.id==b.dataset.edit);if(!p||p.author!==data.name)return;const value=prompt("Измени текст публикации:",p.text);if(value===null)return;p.text=value.trim();p.edited=true;save();render();toast("Публикация обновлена")});root.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>{const id=+b.dataset.delete;const p=data.posts.find(x=>x.id===id);if(!p||p.author!==data.name)return;if(!confirm("Удалить эту публикацию?"))return;data.posts=data.posts.filter(x=>x.id!==id);data.savedIds=data.savedIds.filter(x=>x!==id);save();render();toast("Публикация удалена")});root.querySelectorAll("[data-report]").forEach(b=>b.onclick=()=>toast("Демо: жалоба отмечена локально. В реальной сети нужна модерация."))}
function renderFeed(){let posts=[...data.posts];if(activeTag){const terms={город:["#город","город","улиц","район"],идеи:["#идеи","идея","предлож","план"],события:["#события","событи","встреч","концерт"],фото:["#фото","фото","снимок","картин"]}[activeTag]||["#"+activeTag];posts=posts.filter(p=>terms.some(term=>(p.text||"").toLowerCase().includes(term)))}if(feedSort==="popular")posts.sort((a,b)=>(b.likes||0)-(a.likes||0));else posts.sort((a,b)=>(b.id||0)-(a.id||0));return posts}
function render(){renderStories();const feed=renderFeed();$("#posts").innerHTML=feed.length?feed.map(postHTML).join(""):'<div class="empty">По этому фильтру публикаций нет.</div>';wirePosts($("#posts"));$("#profileName").textContent=data.name;$("#profileBio").textContent=data.bio;$("#postCount").textContent=data.posts.filter(p=>p.author===data.name).length;$("#followingCount").textContent=data.following.length;$("#myPosts").innerHTML=data.posts.filter(p=>p.author===data.name).map(postHTML).join("")||'<div class="empty">Твои публикации появятся здесь.</div>';wirePosts($("#myPosts"));$("#savedPosts").innerHTML=data.posts.filter(p=>data.savedIds.includes(p.id)).map(postHTML).join('')||'<div class="empty">Сохраняй публикации через ☆ — они появятся здесь.</div>';wirePosts($("#savedPosts"));const avatar=avatarHTML(data.name,data.name[0],data.avatar,"profile-avatar avatar-me");const oldAvatar=$(".profile-avatar");if(oldAvatar)oldAvatar.outerHTML=avatar;document.querySelectorAll(".composer .avatar-me").forEach(el=>{if(data.avatar){el.style.backgroundImage=`url(\'${data.avatar}\')`;el.classList.add("has-photo")}});renderSearch();document.querySelectorAll("#topicFilters [data-tag]").forEach(b=>b.classList.toggle("active",b.dataset.tag===activeTag));}
function renderSearch(){const q=($("#searchInput")?.value||"").toLowerCase();const results=data.posts.filter(p=>(p.text+" "+p.author).toLowerCase().includes(q));$("#searchResults").innerHTML=results.length?results.map(postHTML).join(""):'<div class="empty">Ничего не найдено.</div>';wirePosts($("#searchResults"))}
function switchView(id){document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id));document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("selected",b.dataset.view===id));window.scrollTo({top:0,behavior:"smooth"});if(id==="messagesView")$("#msgDot").hidden=true}
document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>switchView(b.dataset.view));
function openComments(id){activeCommentPost=id;const p=data.posts.find(x=>x.id===id);$("#commentsList").innerHTML=p.comments.length?p.comments.map(c=>`<div class="comment"><b>${esc(c.author)}</b>${esc(c.text)}</div>`).join(""):'<div class="empty">Пока нет комментариев.</div>';$("#commentsDialog").showModal()}
$("#commentForm").onsubmit=e=>{e.preventDefault();const value=$("#commentInput").value.trim();if(!value)return;const p=data.posts.find(x=>x.id===activeCommentPost);p.comments.push({author:data.name,text:value});$("#commentInput").value="";save();$("#commentsList").innerHTML=p.comments.map(c=>`<div class="comment"><b>${esc(c.author)}</b>${esc(c.text)}</div>`).join("");render();};
document.querySelector(".close-comments").onclick=()=>$("#commentsDialog").close();
document.querySelectorAll(".close-modal").forEach(b=>b.onclick=()=>b.closest("dialog").close());
$("#editProfile").onclick=()=>{$("#nameInput").value=data.name;$("#bioInput").value=data.bio;pendingAvatar=null;$("#avatarInput").value="";$("#profileDialog").showModal()};
$("#avatarInput").onchange=e=>{const f=e.target.files[0];if(!f)return;if(!f.type.startsWith("image/")){toast("Выбери файл изображения");return}if(f.size>500*1024){toast("Аватар должен быть не больше 500 КБ");e.target.value="";return}const r=new FileReader();r.onload=()=>{pendingAvatar=r.result;toast("Фото выбрано. Нажми «Сохранить»")};r.readAsDataURL(f)};
$("#saveProfile").onclick=e=>{e.preventDefault();data.name=$("#nameInput").value.trim()||"Горожанин";data.bio=$("#bioInput").value.trim();if(pendingAvatar)data.avatar=pendingAvatar;save();$("#profileDialog").close();render();toast("Профиль сохранён")};
$("#postImage").onchange=e=>{const f=e.target.files[0];if(!f)return;if(f.size>1.5*1024*1024){toast("Выбери фото размером до 1,5 МБ");e.target.value="";return}const reader=new FileReader();reader.onload=()=>{pendingImage=reader.result;$("#imageName").textContent=f.name};reader.readAsDataURL(f)};
$("#focusComposer").onclick=()=>$("#postText").focus();$("#navCreate").onclick=()=>{switchView("feedView");$("#postText").focus()};
$("#publishPost").onclick=()=>{const text=$("#postText").value.trim();if(!text&&!pendingImage){toast("Добавь текст или фото");return}data.posts.unshift({id:Date.now(),author:data.name,initial:data.name[0]||"Я",avatar:data.avatar||"",time:"только что",text,likes:0,liked:false,comments:[],image:pendingImage});$("#postText").value="";$("#postImage").value="";$("#imageName").textContent="До 1,5 МБ";pendingImage="";save();render();toast("Публикация добавлена!")};
$("#addStory").onclick=()=>$("#storyDialog").showModal();$("#publishStory").onclick=e=>{e.preventDefault();const text=$("#storyText").value.trim();if(!text){toast("Напиши короткую историю");return}data.stories.unshift({name:data.name,initial:data.name[0]||"Я",text});data.stories=data.stories.slice(0,12);save();$("#storyDialog").close();$("#storyText").value="";renderStories();toast("История добавлена")};
$("#searchInput").oninput=renderSearch;
$("#feedSort").onchange=e=>{feedSort=e.target.value;render()};
$("#clearTag").onclick=()=>{activeTag="";render()};
$("#topicFilters").querySelectorAll("[data-tag]").forEach(b=>b.onclick=()=>{activeTag=b.dataset.tag;switchView("feedView");render()});$("#openMessages").onclick=()=>switchView("messagesView");
$("#resetData").onclick=()=>{if(confirm("Удалить локальные демо-данные NewGorod на этом устройстве?")){localStorage.removeItem(storeKey);data=load();render();toast("Демо-данные сброшены")}};
if("serviceWorker" in navigator && location.protocol.startsWith("http"))navigator.serviceWorker.register("./sw.js").catch(()=>{});
render();

// Keep demo content separated per signed-in account on this browser.
// This is local browser storage, not a shared online feed.
window.addEventListener("newgorod-auth", event => {
  signedInUser = event.detail?.user || null;
  if (typeof messageCryptoKey !== "undefined") {
    messageCryptoKey = null;
    if (typeof setCryptoUnlocked === "function") setCryptoUnlocked(false);
    const messageArea = document.querySelector("#encryptedMessages");
    if (messageArea) messageArea.innerHTML = '<div class="empty">Переписка заблокирована.</div>';
  }
  if (signedInUser) {
    storeKey = "newgorod-demo-v1-" + signedInUser.id;
    data = load();
    if (signedInUser.email && data.name === "Горожанин") data.name = signedInUser.email.split("@")[0].slice(0,30);
    save();
    render();
  }
});


// Local message encryption: plaintext never enters localStorage.
let messageCryptoKey = null;
let encryptedMessageRecords = [];
const cryptoMetaKey = () => storeKey + "-crypto-meta";
const cryptoMessagesKey = () => storeKey + "-encrypted-messages";
const cryptoAvailable = !!(window.crypto && window.crypto.subtle && window.isSecureContext);

function bytesToB64(bytes) {
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
function b64ToBytes(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function deriveMessageKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {name:"PBKDF2", salt, iterations:310000, hash:"SHA-256"},
    material, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]
  );
}
async function encryptMessageText(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    {name:"AES-GCM", iv}, key, new TextEncoder().encode(value)
  );
  return {iv:bytesToB64(iv), cipher:bytesToB64(new Uint8Array(cipher))};
}
async function decryptMessageText(record, key) {
  const plain = await crypto.subtle.decrypt(
    {name:"AES-GCM", iv:b64ToBytes(record.iv)},
    key, b64ToBytes(record.cipher)
  );
  return new TextDecoder().decode(plain);
}
function loadEncryptedRecords() {
  try { encryptedMessageRecords = JSON.parse(localStorage.getItem(cryptoMessagesKey())) || []; }
  catch { encryptedMessageRecords = []; }
}
function renderEncryptedMessages(items) {
  const root=$("#encryptedMessages");
  root.innerHTML=items.length ? items.map(item =>
    `<article class="encrypted-message"><div class="encrypted-message-meta">Ты · ${esc(new Date(item.time).toLocaleString())}</div><p>${esc(item.text)}</p></article>`
  ).join("") : '<div class="empty">Пока сообщений нет. Напиши первое.</div>';
  root.scrollTop=root.scrollHeight;
  $("#encryptedCount").textContent=`${items.length} зашифрованных ${items.length===1?"сообщение":items.length>1&&items.length<5?"сообщения":"сообщений"}`;
}
function setCryptoUnlocked(unlocked) {
  $("#encryptedMessageInput").disabled=!unlocked;
  $("#sendEncryptedMessage").disabled=!unlocked;
  $("#cryptoLockBtn").classList.toggle("hidden",!unlocked);
  $("#cryptoUnlockBtn").classList.toggle("hidden",unlocked);
  $("#cryptoPassphrase").disabled=unlocked;
}
async function unlockEncryptedMessages(passphrase) {
  const metaKey=cryptoMetaKey();
  let meta;
  try { meta=JSON.parse(localStorage.getItem(metaKey)); } catch {}
  if (!meta) {
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const key=await deriveMessageKey(passphrase,salt);
    const check=await encryptMessageText("NewGorod crypto check v1",key);
    meta={salt:bytesToB64(salt),check};
    localStorage.setItem(metaKey,JSON.stringify(meta));
    messageCryptoKey=key;
    loadEncryptedRecords();
    toast("Ключ создан. Сохрани парольную фразу в надёжном месте.");
  } else {
    const key=await deriveMessageKey(passphrase,b64ToBytes(meta.salt));
    const verified=await decryptMessageText(meta.check,key);
    if(verified!=="NewGorod crypto check v1") throw new Error("Неверная парольная фраза.");
    messageCryptoKey=key;
    loadEncryptedRecords();
    toast("Переписка разблокирована.");
  }
  const decrypted=[];
  for(const record of encryptedMessageRecords) {
    decrypted.push({text:await decryptMessageText(record,messageCryptoKey),time:record.time});
  }
  renderEncryptedMessages(decrypted);
  setCryptoUnlocked(true);
  $("#cryptoStatus").textContent="Ключ активен только в памяти этой вкладки. Сообщения хранятся в зашифрованном виде.";
}
if (!cryptoAvailable) {
  $("#cryptoStatus").textContent="Web Crypto недоступен. Открой сайт через HTTPS или localhost.";
  $("#cryptoUnlockForm").querySelectorAll("input,button").forEach(el=>el.disabled=true);
}
$("#cryptoUnlockForm").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!cryptoAvailable)return;
  const pass=$("#cryptoPassphrase").value;
  if(pass.length<10){toast("Парольная фраза должна быть не короче 10 символов.");return;}
  const first=!localStorage.getItem(cryptoMetaKey());
  if(first&&!confirm("Создать локальный ключ? Если потеряешь парольную фразу, сообщения нельзя будет восстановить."))return;
  $("#cryptoUnlockBtn").disabled=true;
  try {
    await unlockEncryptedMessages(pass);
    $("#cryptoPassphrase").value="";
  } catch(error) {
    messageCryptoKey=null;
    setCryptoUnlocked(false);
    $("#cryptoStatus").textContent="Не удалось открыть переписку. Проверь парольную фразу.";
    toast("Ошибка расшифровки: пароль неверен или данные повреждены.");
  } finally {$("#cryptoUnlockBtn").disabled=false;}
});
$("#cryptoLockBtn").onclick=()=>{
  messageCryptoKey=null;
  setCryptoUnlocked(false);
  $("#encryptedMessages").innerHTML='<div class="empty">Переписка заблокирована. Для просмотра введи парольную фразу.</div>';
  $("#cryptoStatus").textContent="Ключ удалён из памяти вкладки.";
};
$("#encryptedMessageForm").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!messageCryptoKey)return;
  const value=$("#encryptedMessageInput").value.trim();
  if(!value)return;
  try {
    const encrypted=await encryptMessageText(value,messageCryptoKey);
    encrypted.time=Date.now();
    encryptedMessageRecords.push(encrypted);
    localStorage.setItem(cryptoMessagesKey(),JSON.stringify(encryptedMessageRecords));
    const visible=await Promise.all(encryptedMessageRecords.map(async r=>({text:await decryptMessageText(r,messageCryptoKey),time:r.time})));
    renderEncryptedMessages(visible);
    $("#encryptedMessageInput").value="";
  } catch(error){toast("Не удалось зашифровать или сохранить сообщение.");}
});
$("#clearEncryptedMessages").onclick=()=>{
  if(!confirm("Удалить все зашифрованные сообщения на этом устройстве?"))return;
  localStorage.removeItem(cryptoMessagesKey());
  encryptedMessageRecords=[];
  if(messageCryptoKey)renderEncryptedMessages([]);
  else $("#encryptedMessages").innerHTML='<div class="empty">Переписка очищена.</div>';
};
