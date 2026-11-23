// NewGorod authentication via Supabase Auth.
// Paste your Supabase Project URL and anon/public key in the two values below.
// NEVER put a service_role/secret key in a website or GitHub repository.
const SUPABASE_URL = "ВСТАВЬТЕ_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = "ВСТАВЬТЕ_SUPABASE_ANON_KEY";

const authClientReady = typeof window.supabase !== "undefined"
  && SUPABASE_URL.startsWith("https://")
  && !SUPABASE_ANON_KEY.startsWith("ВСТАВЬТЕ");

let authClient = null;
let authMode = "login";
const authScreen = document.getElementById("authScreen");
const authForm = document.getElementById("authForm");
const authMessage = document.getElementById("authMessage");
const authSubmit = document.getElementById("authSubmit");
const authTitle = document.getElementById("authTitle");
const authSubtitle = document.getElementById("authSubtitle");
const confirmWrap = document.getElementById("confirmWrap");
const forgotButton = document.getElementById("forgotPassword");
const switchText = document.getElementById("authSwitchText");

function showAuthMessage(message, error=false) {
  authMessage.textContent = message;
  authMessage.classList.toggle("error", error);
}
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  authTitle.textContent = registering ? "Создай аккаунт" : "С возвращением";
  authSubtitle.textContent = registering ? "Присоединяйся к NewGorod." : "Войди, чтобы открыть свой NewGorod.";
  confirmWrap.classList.toggle("hidden", !registering);
  document.getElementById("authConfirm").required = registering;
  document.getElementById("authPassword").autocomplete = registering ? "new-password" : "current-password";
  authSubmit.innerHTML = registering ? "Зарегистрироваться <span>↗</span>" : "Войти <span>↗</span>";
  forgotButton.classList.toggle("hidden", registering);
  switchText.innerHTML = registering
    ? 'Уже есть аккаунт? <button id="showLogin" type="button">Войти</button>'
    : 'Впервые здесь? <button id="showRegister" type="button">Создать аккаунт</button>';
  document.getElementById(registering ? "showLogin" : "showRegister").onclick = () => setAuthMode(registering ? "login" : "register");
  showAuthMessage("");
}
function revealApp(user) {
  document.body.classList.remove("auth-required");
  document.body.classList.add("authenticated");
  authScreen.hidden = true;
  window.dispatchEvent(new CustomEvent("newgorod-auth", {detail:{user}}));
}
function showAuth() {
  document.body.classList.add("auth-required");
  document.body.classList.remove("authenticated");
  authScreen.hidden = false;
}
async function initAuth() {
  if (!authClientReady) {
    showAuthMessage("Сначала подключи Supabase: открой auth.js и вставь Project URL и anon key из настроек проекта.", true);
    return;
  }
  authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const {data, error} = await authClient.auth.getSession();
  if (error) showAuthMessage("Не удалось проверить вход. Попробуй обновить страницу.", true);
  if (data?.session?.user) revealApp(data.session.user);
}
authForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClientReady || !authClient) {
    showAuthMessage("Подключи Supabase в файле auth.js, чтобы регистрация и вход заработали.", true);
    return;
  }
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  authSubmit.disabled = true;
  authSubmit.textContent = "Подожди…";
  try {
    if (authMode === "register") {
      const confirm = document.getElementById("authConfirm").value;
      if (password.length < 8) throw new Error("Пароль должен содержать не менее 8 символов.");
      if (password !== confirm) throw new Error("Пароли не совпадают.");
      const {data,error} = await authClient.auth.signUp({email,password});
      if (error) throw error;
      if (data.session) revealApp(data.user);
      else showAuthMessage("Почти готово! Проверь почту и подтверди адрес, затем войди.");
    } else {
      const {data,error} = await authClient.auth.signInWithPassword({email,password});
      if (error) throw error;
      revealApp(data.user);
    }
  } catch (error) {
    showAuthMessage(error.message || "Не удалось выполнить вход. Проверь данные и попробуй снова.", true);
  } finally {
    authSubmit.disabled = false;
    authSubmit.innerHTML = authMode === "register" ? "Зарегистрироваться <span>↗</span>" : "Войти <span>↗</span>";
  }
});
forgotButton.addEventListener("click", async () => {
  if (!authClientReady || !authClient) return showAuthMessage("Сначала подключи Supabase в auth.js.", true);
  const email = document.getElementById("authEmail").value.trim();
  if (!email) return showAuthMessage("Сначала введи адрес электронной почты.", true);
  const {error} = await authClient.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
  showAuthMessage(error ? error.message : "Если аккаунт с таким адресом существует, придёт письмо для сброса пароля.");
});
document.getElementById("showRegister").onclick = () => setAuthMode("register");
document.getElementById("logoutButton").addEventListener("click", async () => {
  if (authClient) await authClient.auth.signOut();
  window.dispatchEvent(new CustomEvent("newgorod-auth", {detail:{user:null}}));
  showAuth();
  showAuthMessage("Ты вышел из аккаунта.");
});
window.addEventListener("newgorod-auth-refresh", async () => {
  if (!authClient) return;
  const {data} = await authClient.auth.getUser();
  if (data?.user) revealApp(data.user);
});
setAuthMode("login");
initAuth();
