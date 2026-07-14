import { createRenderer } from './mini-renderer.js';

const id = location.pathname.split('/s/')[1] || '';
const titleEl = document.getElementById('sv-title');
const ownerEl = document.getElementById('sv-owner');
const canvas  = document.getElementById('sv-canvas');
const remixBtn = document.getElementById('sv-remix-btn');
const likeBtn  = document.getElementById('sv-like-btn');
const likeCountEl = document.getElementById('sv-like-count');

let shaderDoc = null;

(async function load() {
  const res = await fetch(`/api/shaders/${id}`);
  if (!res.ok) {
    titleEl.textContent = 'Shader not found';
    return;
  }
  shaderDoc = await res.json();
  titleEl.textContent = shaderDoc.title;
  document.title = `${shaderDoc.title} — Shader Tool`;
  ownerEl.textContent = `by @${shaderDoc.ownerName || 'anonymous'}`;
  likeCountEl.textContent = shaderDoc.likeCount || 0;

  const renderer = createRenderer(canvas, shaderDoc.glslSource);
  if (renderer) renderer.start();
})();

remixBtn.addEventListener('click', () => {
  if (!shaderDoc) return;
  localStorage.setItem('shader-showcase-import', shaderDoc.glslSource);
  localStorage.setItem('shader-remix-of', shaderDoc.id);
  window.location.href = '/app';
});

likeBtn.addEventListener('click', async () => {
  if (!shaderDoc) return;
  const res = await fetch(`/api/shaders/${shaderDoc.id}/like`, { method: 'POST', credentials: 'include' });
  if (!res.ok) return;
  const { liked } = await res.json();
  likeBtn.classList.toggle('liked', liked);
  likeCountEl.textContent = Number(likeCountEl.textContent) + (liked ? 1 : -1);
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
