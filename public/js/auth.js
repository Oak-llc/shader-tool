import { createAuthClient } from 'https://esm.sh/better-auth@1.6.23/client';
import { anonymousClient, usernameClient } from 'https://esm.sh/better-auth@1.6.23/client/plugins';

export const authClient = createAuthClient({
  plugins: [anonymousClient(), usernameClient()],
});

let currentUser = null;

export function getUser() {
  return currentUser;
}

// Every visitor gets a silent anonymous account on first load — no form, no friction.
async function ensureSession() {
  const { data } = await authClient.getSession();
  if (data?.user) {
    currentUser = data.user;
    return data.user;
  }
  const { data: signInData } = await authClient.signIn.anonymous();
  currentUser = signInData?.user ?? null;
  return currentUser;
}

function renderWidget(container) {
  const user = currentUser;
  const label = user?.username ? user.username : (user?.name || 'Anonymous');
  container.innerHTML = `
    <button class="btn btn-ghost btn-icon" id="auth-widget-btn" title="${user?.username ? 'Your profile' : 'Claim a username'}">
      <iconify-icon icon="mingcute:user-3-line" width="16" height="16"></iconify-icon>
      <span id="auth-widget-label">${label}</span>
    </button>
  `;
  const btn = container.querySelector('#auth-widget-btn');
  btn.addEventListener('click', async () => {
    if (user?.username) {
      window.location.href = `/u/${user.username}`;
      return;
    }
    const name = window.prompt('Pick a username for your profile (3-24 characters):');
    if (!name?.trim()) return;
    const { error } = await authClient.updateUser({ username: name.trim() });
    if (error) {
      window.alert(error.message || 'That username is taken.');
      return;
    }
    await ensureSession();
    renderWidget(container);
  });
}

export async function initAuthWidget(container) {
  await ensureSession();
  renderWidget(container);
}
