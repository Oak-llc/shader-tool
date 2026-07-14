import { SHOWCASE_SHADERS } from './showcase-shaders.js';
import { createRenderer } from './mini-renderer.js';

// ── Build grid ────────────────────────────────────────────────────────────────

const grid          = document.getElementById('showcase-grid');
const communityGrid = document.getElementById('community-grid');
const tabButtons     = document.querySelectorAll('.showcase-tab');
const maximize  = document.getElementById('sc-maximize');
const maxCanvas = document.getElementById('sc-max-canvas');
const backBtn   = document.getElementById('sc-back-btn');
const openBtn   = document.getElementById('sc-open-btn');
const maxTitle  = document.getElementById('sc-maximize-title');
const infoName  = document.getElementById('sc-info-name');
const infoDesc  = document.getElementById('sc-info-desc');
const openBtnLabel = document.getElementById('sc-open-btn-label');

let activeMaxRenderer = null;
let currentShaderData = null;

const cardRenderers = new Map(); // card element → renderer

function buildCard(shader) {
  const card = document.createElement('div');
  card.className = 'sc-card';

  const canvas = document.createElement('canvas');
  // Physical size set later by renderer; CSS handles display size
  canvas.width  = 640;
  canvas.height = 360;
  card.appendChild(canvas);

  const info = document.createElement('div');
  info.className = 'sc-card-info';
  info.innerHTML = `<div class="sc-card-name">${shader.name}</div>`
                 + `<div class="sc-card-desc">${shader.description}</div>`;
  card.appendChild(info);

  const renderer = createRenderer(canvas, shader.glsl);
  if (!renderer) {
    const err = document.createElement('div');
    err.className = 'sc-card-error';
    err.textContent = 'WebGL2 not supported';
    card.replaceChild(err, canvas);
  } else {
    cardRenderers.set(card, renderer);
  }

  card.addEventListener('click', () => showMaximize(shader));
  return card;
}

function buildCommunityCard(doc) {
  const shader = {
    id: doc.id,
    name: doc.title,
    description: `by ${doc.ownerName || 'Anonymous'}`,
    glsl: doc.glslSource,
    remixOfId: doc.remixOfId,
  };

  const card = buildCard(shader);

  const meta = document.createElement('div');
  meta.className = 'sc-card-meta';
  meta.innerHTML = `
    <a class="sc-card-owner" href="/u/${encodeURIComponent(doc.ownerName || '')}">@${doc.ownerName || 'anonymous'}</a>
    <button class="sc-card-like-btn" data-id="${doc.id}">
      <iconify-icon icon="mingcute:heart-line" width="13" height="13"></iconify-icon>
      <span class="sc-card-like-count">${doc.likeCount || 0}</span>
    </button>
  `;
  card.querySelector('.sc-card-info').appendChild(meta);

  meta.querySelector('.sc-card-like-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const res = await fetch(`/api/shaders/${doc.id}/like`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return;
    const { liked } = await res.json();
    btn.classList.toggle('liked', liked);
    const countEl = btn.querySelector('.sc-card-like-count');
    countEl.textContent = Number(countEl.textContent) + (liked ? 1 : -1);
  });

  return card;
}

// Populate grid
SHOWCASE_SHADERS.forEach(shader => {
  grid.appendChild(buildCard(shader));
});

// ── Community tab ─────────────────────────────────────────────────────────────

let communityLoaded = false;

async function loadCommunityFeed() {
  if (communityLoaded) return;
  communityLoaded = true;
  try {
    const res = await fetch('/api/shaders/feed/recent');
    const docs = await res.json();
    if (!docs.length) {
      communityGrid.innerHTML = '<p class="sc-card-desc" style="grid-column:1/-1">No community shaders yet — be the first to save one from the editor.</p>';
      return;
    }
    docs.forEach(doc => {
      const card = buildCommunityCard(doc);
      communityGrid.appendChild(card);
      observer.observe(card);
    });
  } catch (err) {
    console.warn('Failed to load community feed:', err);
  }
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('showcase-tab--active'));
    btn.classList.add('showcase-tab--active');
    const tab = btn.dataset.tab;
    grid.hidden = tab !== 'curated';
    communityGrid.hidden = tab !== 'community';
    if (tab === 'community') loadCommunityFeed();
  });
});

// ── IntersectionObserver: animate only visible cards ─────────────────────────

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const renderer = cardRenderers.get(entry.target);
    if (!renderer) return;
    if (entry.isIntersecting) renderer.start();
    else renderer.stop();
  });
}, { rootMargin: '120px' });

cardRenderers.forEach((_, card) => observer.observe(card));

// ── Maximize view ─────────────────────────────────────────────────────────────

function showMaximize(shader) {
  currentShaderData = shader;

  maxTitle.textContent  = shader.name;
  infoName.textContent  = shader.name;
  infoDesc.textContent  = shader.description;
  openBtnLabel.textContent = shader.id ? 'Remix in Editor' : 'Open in Editor';

  // Pause all card renderers while maximized
  cardRenderers.forEach(r => r.stop());
  observer.disconnect();

  // Create full-res renderer on the maximize canvas
  if (activeMaxRenderer) activeMaxRenderer.stop();
  activeMaxRenderer = createRenderer(maxCanvas, shader.glsl);
  if (activeMaxRenderer) activeMaxRenderer.start();

  maximize.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function hideMaximize() {
  maximize.classList.remove('open');
  document.body.style.overflow = '';

  if (activeMaxRenderer) {
    activeMaxRenderer.stop();
    activeMaxRenderer = null;
  }

  // Reconnect observer so cards resume animating
  cardRenderers.forEach((_, card) => observer.observe(card));
}

backBtn.addEventListener('click', hideMaximize);

openBtn.addEventListener('click', () => {
  if (!currentShaderData) return;
  localStorage.setItem('shader-showcase-import', currentShaderData.glsl);
  if (currentShaderData.id) {
    localStorage.setItem('shader-remix-of', currentShaderData.id);
  } else {
    localStorage.removeItem('shader-remix-of');
  }
  window.location.href = '/app';
});

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && maximize.classList.contains('open')) hideMaximize();
});

// ── Theme toggle ──────────────────────────────────────────────────────────────

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
