import { createRenderer } from './mini-renderer.js';

const username   = decodeURIComponent(location.pathname.split('/u/')[1] || '');
const grid       = document.getElementById('showcase-grid');
const maximize   = document.getElementById('sc-maximize');
const maxCanvas  = document.getElementById('sc-max-canvas');
const backBtn    = document.getElementById('sc-back-btn');
const openBtn    = document.getElementById('sc-open-btn');
const maxTitle   = document.getElementById('sc-maximize-title');
const infoName   = document.getElementById('sc-info-name');
const infoDesc   = document.getElementById('sc-info-desc');
const emptyLabel = document.getElementById('profile-empty');

document.getElementById('profile-username').textContent = `@${username}`;
document.title = `@${username} — Shader Tool`;

let activeMaxRenderer = null;
let currentShaderData = null;
const cardRenderers = new Map();

function buildCard(doc) {
  const card = document.createElement('div');
  card.className = 'sc-card';

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  card.appendChild(canvas);

  const info = document.createElement('div');
  info.className = 'sc-card-info';
  info.innerHTML = `<div class="sc-card-name">${doc.title}</div>`
                 + `<div class="sc-card-desc">${doc.likeCount || 0} like${doc.likeCount === 1 ? '' : 's'}</div>`;
  card.appendChild(info);

  const renderer = createRenderer(canvas, doc.glslSource);
  if (!renderer) {
    const err = document.createElement('div');
    err.className = 'sc-card-error';
    err.textContent = 'WebGL2 not supported';
    card.replaceChild(err, canvas);
  } else {
    cardRenderers.set(card, renderer);
  }

  card.addEventListener('click', () => showMaximize(doc));
  return card;
}

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const renderer = cardRenderers.get(entry.target);
    if (!renderer) return;
    if (entry.isIntersecting) renderer.start();
    else renderer.stop();
  });
}, { rootMargin: '120px' });

function showMaximize(doc) {
  currentShaderData = doc;
  maxTitle.textContent = doc.title;
  infoName.textContent = doc.title;
  infoDesc.textContent = `by @${username}`;

  cardRenderers.forEach(r => r.stop());
  observer.disconnect();

  if (activeMaxRenderer) activeMaxRenderer.stop();
  activeMaxRenderer = createRenderer(maxCanvas, doc.glslSource);
  if (activeMaxRenderer) activeMaxRenderer.start();

  maximize.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function hideMaximize() {
  maximize.classList.remove('open');
  document.body.style.overflow = '';
  if (activeMaxRenderer) { activeMaxRenderer.stop(); activeMaxRenderer = null; }
  cardRenderers.forEach((_, card) => observer.observe(card));
}

backBtn.addEventListener('click', hideMaximize);
openBtn.addEventListener('click', () => {
  if (!currentShaderData) return;
  localStorage.setItem('shader-showcase-import', currentShaderData.glslSource);
  localStorage.setItem('shader-remix-of', currentShaderData.id);
  window.location.href = '/app';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && maximize.classList.contains('open')) hideMaximize();
});

const themeToggle = document.getElementById('theme-toggle');
themeToggle.addEventListener('click', () => {
  const current = localStorage.getItem('shader-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('shader-theme', next);
  document.documentElement.setAttribute('data-theme', next);
  themeToggle.innerHTML = next === 'light'
    ? '<iconify-icon icon="mingcute:sun-line" width="18" height="18"></iconify-icon>'
    : '<iconify-icon icon="mingcute:moon-line" width="18" height="18"></iconify-icon>';
});

// ── Load profile feed ──────────────────────────────────────────────────────────
(async function loadProfile() {
  const res = await fetch(`/api/users/${encodeURIComponent(username)}/shaders`);
  const docs = await res.json();
  if (!docs.length) {
    emptyLabel.hidden = false;
    return;
  }
  docs.forEach(doc => {
    const card = buildCard(doc);
    grid.appendChild(card);
    observer.observe(card);
  });
})();
