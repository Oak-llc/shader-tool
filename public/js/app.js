import { Renderer } from './renderer.js';
import { extractUniforms } from './parser.js';
import { ControlsPanel } from './controls.js';
import { generateShader } from './ai.js';
import { exportGLSL, exportVanillaJS, exportReact, exportSvelte } from './exporters.js';

const PROVIDER_MODEL_LABELS = {
  anthropic: 'Claude',
  openai:    'GPT-4o',
  gemini:    'Gemini',
  local:     'Local model',
};

function getModelLabel() {
  const provider = localStorage.getItem('shader-provider') || 'anthropic';
  if (provider === 'local') {
    return localStorage.getItem('shader-local-model') || 'Local model';
  }
  return PROVIDER_MODEL_LABELS[provider] || provider;
}

function getApiKey(provider) {
  return localStorage.getItem('shader-api-key-' + provider)
      || localStorage.getItem('shader-api-key')
      || '';
}

function hasCredential(provider) {
  if (provider === 'local') return !!localStorage.getItem('shader-local-url');
  return !!getApiKey(provider);
}

function providerHeaders() {
  const provider = localStorage.getItem('shader-provider') || 'anthropic';
  const h = { 'Content-Type': 'application/json', 'X-Provider': provider };
  if (provider === 'local') {
    const url   = localStorage.getItem('shader-local-url');
    const model = localStorage.getItem('shader-local-model');
    if (url)   h['X-Local-URL']   = url;
    if (model) h['X-Local-Model'] = model;
  } else {
    const key = getApiKey(provider);
    if (key) h['X-API-Key'] = key;
  }
  return h;
}

// Migrate legacy single api key to per-provider storage
(function migrateApiKey() {
  const legacy = localStorage.getItem('shader-api-key');
  if (!legacy) return;
  const provider = localStorage.getItem('shader-provider') || 'anthropic';
  if (provider !== 'local' && !localStorage.getItem('shader-api-key-' + provider)) {
    localStorage.setItem('shader-api-key-' + provider, legacy);
  }
})();

// ── State ───────────────────────────────────────────────────────────────────
let renderer;
let currentShader = null;
let generating = false;
const history = [];
let monacoEditor = null;
let referenceImage = null; // { base64: string, mediaType: string }
let activeHistoryItem = null;
let activePresetIndex = null;
let _saveParamsTimer = null;
let _historySearchQuery = '';
const _historyTagFilter = new Set();
let _historySort = null; // null | 'asc' | 'desc'
function debounceSaveHistory() {
  clearTimeout(_saveParamsTimer);
  _saveParamsTimer = setTimeout(saveHistory, 400);
}

let _saveIndicatorTimer = null;
function showSaveIndicator() {
  saveIndicator.style.opacity = '1';
  clearTimeout(_saveIndicatorTimer);
  _saveIndicatorTimer = setTimeout(() => { saveIndicator.style.opacity = '0'; }, 2000);
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas          = document.getElementById('shader-canvas');
const promptInput     = document.getElementById('prompt-input');
const promptCharCount = document.getElementById('prompt-char-count');

{
  const placeholders = [
    "Describe your shader… (e.g., 'bloom effect', 'terrain noise', 'CRT scanlines')",
    "Define your GLSL visual goal… (e.g., 'vertex displacement using heightmap', 'pixelated sprite renderer')",
    "Describe shader effect or logic… (e.g., 'water reflection', 'raymarching scene')",
    "What visual behavior do you want? (e.g., 'volumetric fog in fragment shader', 'sine wave distortion')",
  ];
  promptInput.placeholder = placeholders[Math.floor(Math.random() * placeholders.length)];
}

{
  const LIMIT = 10_000;
  function updateCharCount() {
    const remaining = LIMIT - promptInput.value.length;
    promptCharCount.textContent = remaining.toLocaleString() + ' characters remaining';
    promptCharCount.classList.toggle('near-limit', remaining <= 500 && remaining > 0);
    promptCharCount.classList.toggle('at-limit', remaining <= 0);
  }
  promptInput.addEventListener('input', updateCharCount);
}

const generateBtn     = document.getElementById('generate-btn');
const randomBtn       = document.getElementById('random-btn');
const pauseBtn        = document.getElementById('pause-btn');
const resetBtn        = document.getElementById('reset-time-btn');
const fullscreenBtn   = document.getElementById('fullscreen-btn');
const historyList     = document.getElementById('history-list');
const statusBar       = document.getElementById('status-bar');
const errorBanner     = document.getElementById('error-banner');
const compileBtn        = document.getElementById('compile-btn');
const editorModeSelect  = document.getElementById('editor-mode-select');
const glslEditorEl      = document.getElementById('glsl-editor');
const compilerLogsEl    = document.getElementById('compiler-logs');
const logListEl         = document.getElementById('log-list');
const clearLogsBtn      = document.getElementById('clear-logs-btn');
const adaptBtnWrap      = document.getElementById('adapt-btn-wrap');
const paramsPanel     = document.getElementById('params-panel');
const systemParams    = document.getElementById('system-params');
const userParams      = document.getElementById('user-params');
const exportBtn       = document.getElementById('export-btn');
const exportMenu      = document.getElementById('export-menu');
const modal           = document.getElementById('export-modal');
const modalTitle      = document.getElementById('modal-title');
const modalCode       = document.getElementById('modal-code');
const modalCopy       = document.getElementById('modal-copy');
const modalClose      = document.getElementById('modal-close');
const explanationEl   = document.getElementById('explanation');
const streamPreview   = document.getElementById('stream-preview');
const streamContent   = document.getElementById('stream-content');
const terminalBadge   = document.getElementById('terminal-badge');
const thinkingPanel   = document.getElementById('thinking-panel');
const thinkingToggle  = document.getElementById('thinking-toggle');
const thinkingContent = document.getElementById('thinking-content');
const thinkingLabel   = document.getElementById('thinking-label');
const thinkingArrow   = document.getElementById('thinking-arrow');
const thinkingSpinner = document.getElementById('thinking-spinner');
const themeToggle     = document.getElementById('theme-toggle');
const canvasWrap      = document.getElementById('canvas-wrap');
const imageBtn        = document.getElementById('image-btn');
const imageUpload     = document.getElementById('image-upload');
const imagePreviewWrap = document.getElementById('image-preview-wrap');
const imagePreviewThumb = document.getElementById('image-preview-thumb');
const imageRemoveBtn  = document.getElementById('image-remove-btn');
const saveIndicator      = document.getElementById('save-indicator');
const adaptBtn           = document.getElementById('adapt-btn');
const editorResizeHandle = document.getElementById('editor-resize-handle');
const rightResizeHandle  = document.getElementById('right-resize-handle');
const leftResizeHandle   = document.getElementById('left-resize-handle');
const newSessionBtn      = document.getElementById('new-session-btn');
const paramCopyBtn       = document.getElementById('param-copy-btn');
const paramEditBtn       = document.getElementById('param-edit-btn');
const paramSaveBtn       = document.getElementById('param-save-btn');
const manualSaveBtn      = document.getElementById('manual-save-btn');
const paramsEditBar      = document.getElementById('params-edit-bar');
const paramsEditCount    = document.getElementById('params-edit-count');
const paramsEditCancel   = document.getElementById('params-edit-cancel');
const paramsEditDelete   = document.getElementById('params-edit-delete');
const paramAddBtn        = document.getElementById('param-add-btn');
const paramAddDropdown   = document.getElementById('param-add-dropdown');
const paramRowsEl        = document.getElementById('param-rows');
const paramAddRowBtn     = document.getElementById('param-add-row-btn');
const paramAddSubmit     = document.getElementById('param-add-submit');
const undoBtn            = document.getElementById('undo-btn');
const redoBtn            = document.getElementById('redo-btn');
const presetsBar         = document.getElementById('presets-bar');
const presetsList        = document.getElementById('presets-list');
const presetCaptureBtn   = document.getElementById('preset-capture-btn');
const enhancePromptBtn      = document.getElementById('enhance-prompt-btn');
const enhanceShaderWrap     = document.getElementById('enhance-shader-wrap');
const enhanceShaderBtn      = document.getElementById('enhance-shader-btn');
const enhanceShaderPopover  = document.getElementById('enhance-shader-popover');
const enhanceShaderInput    = document.getElementById('enhance-shader-input');
const enhanceShaderSubmit   = document.getElementById('enhance-shader-submit');
const sweetenersToggle   = document.getElementById('sweeteners-toggle');
const sweetenersArrow    = document.getElementById('sweeteners-arrow');
const sweetenersPanel    = document.getElementById('sweeteners-panel');
const historyToggle        = document.getElementById('history-toggle');
const historyArrow         = document.getElementById('history-arrow');
const historyControls      = document.getElementById('history-controls');
const historySearch        = document.getElementById('history-search');
const historySortBtn       = document.getElementById('history-sort-btn');
const historyTagFilterBtn  = document.getElementById('history-tag-filter-btn');
const historyTagFilterMenu = document.getElementById('history-tag-filter-menu');
const historyFilterBadge   = document.getElementById('history-filter-badge');
const descriptionToggle  = document.getElementById('description-toggle');
const descriptionArrow   = document.getElementById('description-arrow');
const descriptionSection = document.getElementById('description-section');
const leftCollapseBtn       = document.getElementById('left-collapse-btn');
const mainEl                = document.getElementById('main');
const promptSectionToggle   = document.getElementById('prompt-section-toggle');
const leftPanel             = document.getElementById('left-panel');
const helpBtn            = document.getElementById('help-btn');
const helpModal          = document.getElementById('help-modal');
const helpClose          = document.getElementById('help-close');
const providerSwitcher   = document.getElementById('provider-switcher');

// ── Monaco init ──────────────────────────────────────────────────────────────
monacoEditor = await window._monacoReady;

monacoEditor.onDidChangeModelContent(() => {
  compileBtn.classList.add('dirty');
});

// ── Presets ───────────────────────────────────────────────────────────────────
function renderPresets() {
  const item = activeHistoryItem;
  presetsBar.hidden = !item;
  if (!item) return;

  const presets = item.presets || [];
  presetsList.innerHTML = '';

  for (let i = 0; i < presets.length; i++) {
    const preset = presets[i];
    const chip = document.createElement('span');
    chip.className = 'preset-chip' + (i === activePresetIndex ? ' preset-chip--active' : '');

    const label = document.createElement('span');
    label.className = 'preset-chip__label';
    label.textContent = preset.name;
    chip.appendChild(label);

    const del = document.createElement('button');
    del.className = 'preset-chip__del';
    del.textContent = '×';
    del.title = 'Remove preset';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      presets.splice(i, 1);
      if (activePresetIndex === i) activePresetIndex = null;
      else if (activePresetIndex !== null && activePresetIndex > i) activePresetIndex--;
      saveHistory();
      renderPresets();
    });
    chip.appendChild(del);

    chip.addEventListener('click', () => {
      if (!currentShader) return;
      activePresetIndex = i;
      controls.rebuild(extractUniforms(currentShader), preset.values);
      renderPresets();
    });

    chip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      _startRenamePreset(chip, label, presets, i);
    });

    presetsList.appendChild(chip);
  }
}

function _startRenamePreset(chip, labelEl, presets, i) {
  chip.classList.add('preset-chip--renaming');
  chip.classList.remove('preset-chip--active');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = presets[i].name;
  chip.insertBefore(input, labelEl);
  input.select();

  let settled = false;
  function commit() {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    if (val) presets[i].name = val;
    saveHistory();
    renderPresets();
  }
  function cancel() {
    if (settled) return;
    settled = true;
    renderPresets();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.focus();
}

function capturePreset() {
  if (!activeHistoryItem) return;
  activeHistoryItem.presets = activeHistoryItem.presets || [];
  const presets = activeHistoryItem.presets;
  presets.push({ name: 'Preset ' + (presets.length + 1), values: controls.getValues() });
  activePresetIndex = presets.length - 1;
  saveHistory();
  renderPresets();

  const chips = presetsList.querySelectorAll('.preset-chip');
  const newChip = chips[chips.length - 1];
  if (newChip) {
    const labelEl = newChip.querySelector('.preset-chip__label');
    _startRenamePreset(newChip, labelEl, presets, presets.length - 1);
  }
}

presetCaptureBtn.addEventListener('click', capturePreset);

// ── Undo / Redo ──────────────────────────────────────────────────────────────
const MAX_UNDO = 50;
const undoStack = [];
let undoIdx = -1;

function pushUndoState(shader, params) {
  undoStack.splice(undoIdx + 1);
  undoStack.push({ shader, params: { ...params } });
  if (undoStack.length > MAX_UNDO) { undoStack.shift(); }
  undoIdx = undoStack.length - 1;
  syncUndoBtns();
}

function applyUndoState(state) {
  currentShader = state.shader;
  monacoEditor.setValue(state.shader);
  renderer.compile(state.shader);
  renderer.resetTime();
  const uniforms = extractUniforms(state.shader);
  controls.rebuild(uniforms, state.params || {});
}

function syncUndoBtns() {
  undoBtn.disabled = undoIdx <= 0;
  redoBtn.disabled = undoIdx >= undoStack.length - 1;
}

undoBtn.addEventListener('click', () => {
  if (undoIdx <= 0) return;
  undoIdx--;
  applyUndoState(undoStack[undoIdx]);
  syncUndoBtns();
  setStatus('Undo');
});

redoBtn.addEventListener('click', () => {
  if (undoIdx >= undoStack.length - 1) return;
  undoIdx++;
  applyUndoState(undoStack[undoIdx]);
  syncUndoBtns();
  setStatus('Redo');
});

document.addEventListener('keydown', (e) => {
  const inMonaco = monacoEditor.getDomNode().contains(document.activeElement);
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    if (inMonaco) return;
    e.preventDefault();
    undoBtn.click();
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    if (inMonaco) return;
    e.preventDefault();
    redoBtn.click();
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
renderer = new Renderer(canvas);

renderer.onError = (msg) => showError(parseGLSLError(msg), true);
renderer.onCompileSuccess = () => {
  clearError();
  compileBtn.classList.remove('dirty');
  setStatus('Compiled successfully');
};

function renameParamInShader(src, uniformName, newLabel) {
  return src.split('\n').map(line => {
    if (!new RegExp(`uniform\\s+\\S+\\s+${uniformName}\\s*;`).test(line)) return line;
    if (/label:"[^"]*"/.test(line)) {
      return line.replace(/label:"[^"]*"/, `label:"${newLabel}"`);
    }
    if (/\/\/\s*@param/.test(line)) {
      return line.replace(/(\/\/\s*@param\s*)/, `$1label:"${newLabel}" `);
    }
    return line;
  }).join('\n');
}

const controls = new ControlsPanel(userParams, (name, value) => {
  renderer.setUniform(name, value);
  if (activeHistoryItem) {
    activeHistoryItem.params = activeHistoryItem.params || {};
    activeHistoryItem.params[name] = value;
    debounceSaveHistory();
  }
}, (uniformName, newLabel) => {
  const src = monacoEditor.getValue();
  const updated = renameParamInShader(src, uniformName, newLabel);
  monacoEditor.setValue(updated);
  const err = renderer.compile(updated);
  if (!err) {
    currentShader = updated;
    if (activeHistoryItem) { activeHistoryItem.shader = updated; saveHistory(); }
    controls.rebuild(extractUniforms(updated), controls.getValues());
  }
});

// ── Resolution control (per-shader, saved with history item) ─────────────────
const RES_STEPS = [
  { label: 'Low',  value: 0.25 },
  { label: 'Med',  value: 0.5  },
  { label: 'High', value: 0.75 },
  { label: 'Max',  value: 1.0  },
];

let _resGroup;

function setResolution(value) {
  renderer.renderScale = value;
  if (_resGroup) {
    _resGroup.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('seg-btn--active', parseFloat(b.dataset.resValue) === value);
    });
  }
}

(function buildResolutionControl() {
  const wrap = document.createElement('div');
  wrap.className = 'control-row control-row--system';

  const label = document.createElement('label');
  label.className = 'control-label';
  label.textContent = 'Resolution';

  const group = document.createElement('div');
  group.className = 'seg-group';
  _resGroup = group;

  RES_STEPS.forEach(({ label: lbl, value }) => {
    const btn = document.createElement('button');
    btn.className = 'seg-btn';
    btn.textContent = lbl;
    btn.dataset.resValue = value;
    if (value === 1.0) btn.classList.add('seg-btn--active');
    btn.addEventListener('click', () => {
      setResolution(value);
      if (activeHistoryItem) {
        activeHistoryItem.renderScale = value;
        debounceSaveHistory();
      }
    });
    group.appendChild(btn);
  });

  wrap.appendChild(label);
  wrap.appendChild(group);
  systemParams.appendChild(wrap);
})();

// ── Resize observer ──────────────────────────────────────────────────────────
new ResizeObserver(() => {
  canvas.width = 0;
}).observe(canvas);

// ── Load persisted history ────────────────────────────────────────────────────
try {
  const restoreSession = localStorage.getItem('shader-restore-session') !== 'false';
  if (restoreSession) {
    const saved = localStorage.getItem('shader-history');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        history.push(...parsed.slice(0, 20));
        renderHistory();
      }
    }
  }
} catch (_) {}

// ── Showcase import ───────────────────────────────────────────────────────────
try {
  const imported = localStorage.getItem('shader-showcase-import');
  if (imported) {
    localStorage.removeItem('shader-showcase-import');
    const err = renderer.compile(imported);
    if (!err) {
      currentShader = imported;
      monacoEditor.setValue(imported);
      renderer.resetTime();
      setResolution(1.0);
      const uniforms = extractUniforms(imported);
      controls.rebuild(uniforms);
      setStatus('Shader imported from Showcase — ' + uniforms.length + ' parameter(s)');
    }
  }
} catch (_) {}

// ── Load persisted theme ──────────────────────────────────────────────────────
(function applyTheme() {
  const saved = localStorage.getItem('shader-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  themeToggle.innerHTML = saved === 'light'
    ? '<iconify-icon icon="mingcute:sun-line" width="18" height="18"></iconify-icon>'
    : '<iconify-icon icon="mingcute:moon-line" width="18" height="18"></iconify-icon>';
})();

// ── Generate ─────────────────────────────────────────────────────────────────
async function doGenerate() {
  const prompt = promptInput.value.trim();
  if (!prompt || generating) return;

  generating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';
  clearError();
  setStatus('Calling ' + getModelLabel() + '…');
  streamContent.innerHTML = '';
  terminalBadge.textContent = 'generating…';
  streamPreview.style.display = 'block';
  explanationEl.textContent = '';
  descriptionSection.hidden = true;

  // Reset thinking panel
  thinkingPanel.hidden = true;
  thinkingContent.hidden = false;
  thinkingContent.textContent = '';
  thinkingLabel.textContent = 'Thinking…';
  thinkingSpinner.hidden = false;
  thinkingArrow.classList.add('open');

  let streamBuf = '';
  let thinkingBuf = '';

  await generateShader(prompt, currentShader, referenceImage, {
    onThinking(text) {
      thinkingBuf += text;
      thinkingPanel.hidden = false;
      thinkingContent.textContent = thinkingBuf;
      thinkingContent.scrollTop = thinkingContent.scrollHeight;
    },
    onDelta(text) {
      streamBuf += text;
      streamContent.innerHTML = glslHighlight(streamBuf.slice(-800)) + '<span class="t-cursor"></span>';
      streamContent.scrollTop = streamContent.scrollHeight;
    },
    async onDone(shader, explanation) {
      if (thinkingBuf) {
        thinkingLabel.textContent = 'Thought';
        thinkingSpinner.hidden = true;
        thinkingContent.hidden = true;
        thinkingArrow.classList.remove('open');
      }
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';

      if (!shader) {
        showError('AI did not return a valid GLSL shader. Try rephrasing your prompt.');
        finish();
        return;
      }

      appendLog('info', 'Compiling generated shader…');
      const compileError = tryCompile(shader);
      if (compileError) {
        appendLog('error', parseGLSLError(compileError));
        setStatus('Compile error — asking ' + getModelLabel() + ' to fix…');
        generateBtn.textContent = 'Fixing…';
        clearError();
        appendLog('info', 'Asking ' + getModelLabel() + ' to auto-fix…');
        const fixed = await autoFix(shader, compileError);
        if (!fixed) { finish(); return; }
        shader = fixed;
      }

      currentShader = shader;
      monacoEditor.setValue(shader);
      renderer.resetTime();
      const uniforms = extractUniforms(shader);
      controls.rebuild(uniforms);
      pushUndoState(shader, controls.getValues());
      setStatus('Shader compiled — ' + uniforms.length + ' parameter(s)');
      appendLog('success', 'Shader compiled — ' + uniforms.length + ' parameter(s)');

      if (explanation) {
        explanationEl.textContent = explanation;
        descriptionSection.hidden = false;
        explanationEl.hidden = false;
        descriptionArrow.classList.add('open');
        localStorage.setItem('shader-description-open', 'true');
      }
      setResolution(1.0);
      addHistory(prompt);
      finish();
    },
    onError(msg) {
      if (thinkingBuf) {
        thinkingLabel.textContent = 'Thought';
        thinkingSpinner.hidden = true;
        thinkingContent.hidden = true;
        thinkingArrow.classList.remove('open');
      }
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';
      showError(msg);
      finish();
    },
  });
}

function tryCompile(shader) {
  const origOnError = renderer.onError;
  const origOnSuccess = renderer.onCompileSuccess;
  renderer.onError = null;
  renderer.onCompileSuccess = null;
  const err = renderer.compile(shader);
  renderer.onError = origOnError;
  renderer.onCompileSuccess = origOnSuccess;
  return err;
}

async function autoFix(brokenShader, errorMsg) {
  const fixPrompt = `This GLSL shader has a compilation error. Fix it so it compiles correctly without changing the visual intent. Only output the corrected shader — do not explain the changes before the code block.

Compilation error:
${parseGLSLError(errorMsg)}`;

  return new Promise((resolve) => {
    generateShader(fixPrompt, brokenShader, null, {
      onDelta() {},
      onDone(fixedShader) {
        if (!fixedShader) { showError('Auto-fix failed — try rephrasing your prompt.'); resolve(null); return; }
        const err = tryCompile(fixedShader);
        if (err) { showError('Auto-fix could not resolve: ' + parseGLSLError(err)); resolve(null); return; }
        resolve(fixedShader);
      },
      onError(msg) { showError(msg); resolve(null); },
    });
  });
}

function finish() {
  generating = false;
  generateBtn.disabled = false;
  generateBtn.textContent = 'Generate';
}

generateBtn.addEventListener('click', doGenerate);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doGenerate();
});

// ── Sweeteners ────────────────────────────────────────────────────────────────
const SWEETENERS = {
  technique: [
    { label: 'fBm noise',      append: 'textured with layered fractal Brownian motion noise',                         tooltip: 'Adds organic, cloudy texture by stacking noise at different scales — like marble veins, smoke, or rolling terrain.' },
    { label: 'domain warp',    append: 'with domain-warped UV distortion for a fluid, turbulent look',                tooltip: 'Twists the pattern back into itself, creating swirling, fluid distortion — like ink dropped in water.' },
    { label: 'SDF shapes',     append: 'built from signed distance field primitives with smooth blending',             tooltip: 'Builds crisp geometric shapes (circles, boxes, rings) that can smoothly melt into each other.' },
    { label: 'kaleidoscope',   append: 'with kaleidoscopic N-fold mirror symmetry',                                   tooltip: 'Mirrors the pattern symmetrically around the center, like looking through a kaleidoscope.' },
    { label: 'polar coords',   append: 'mapped through polar coordinates for radial symmetry',                         tooltip: 'Wraps the pattern into a circle, producing rings, spirals, and effects that radiate outward from the center.' },
    { label: 'HSV cycling',    append: 'with animated HSV color wheel cycling through the spectrum',                   tooltip: 'Continuously shifts colors through the full rainbow over time — everything slowly changes hue.' },
    { label: 'tiling grid',    append: 'tiled across a repeating grid with per-cell variation',                        tooltip: 'Tiles the pattern across a repeating grid where each cell is slightly different.' },
    { label: 'voronoi',        append: 'using Voronoi cell decomposition',                                            tooltip: 'Divides the canvas into irregular regions — like cracked earth, cell membranes, or stained glass.' },
    { label: 'reaction-diff',  append: 'simulating reaction-diffusion pattern formation',                              tooltip: 'Simulates two chemicals spreading and reacting — naturally produces spots, stripes, and organic blobs.' },
  ],
  theme: [
    { label: 'neon glow',      append: 'with glowing neon bloom and dark background' },
    { label: 'aurora',         append: 'with aurora borealis ribbon light in greens and purples' },
    { label: 'deep space',     append: 'set against the deep black of interstellar space' },
    { label: 'lava',           append: 'resembling slow-moving molten lava and magma' },
    { label: 'underwater',     append: 'with underwater caustic light dappling' },
    { label: 'circuit board',  append: 'inspired by glowing PCB circuit traces' },
    { label: 'mycelium',       append: 'resembling branching mycelium or fungal networks' },
    { label: 'holographic',    append: 'with a holographic iridescent sheen' },
    { label: 'retro CRT',      append: 'with a retro CRT phosphor glow and scanlines' },
  ],
  color: [
    { label: 'monochrome',     append: 'in a stark black and white monochrome palette' },
    { label: 'warm amber',     append: 'using a warm amber, gold, and deep-red palette' },
    { label: 'cool blues',     append: 'in cool icy blue and cyan tones' },
    { label: 'pastel',         append: 'with soft muted pastel colors' },
    { label: 'high contrast',  append: 'with punchy high-contrast colors on a black ground' },
    { label: 'earth tones',    append: 'using earthy terracotta, ochre, and moss tones' },
    { label: 'acid green',     append: 'in acid green and electric yellow on black' },
  ],
};

(function buildSweeteners() {
  for (const [group, items] of Object.entries(SWEETENERS)) {
    const container = document.getElementById(`sweeteners-${group}`);
    for (const item of items) {
      const pill = document.createElement('button');
      pill.className = 'sweetener-pill';
      pill.textContent = item.label;
      pill.title = item.tooltip ?? item.append;
      pill.addEventListener('click', () => {
        const cur = promptInput.value.trimEnd();
        promptInput.value = cur ? `${cur}, ${item.append}` : item.append;
        pill.classList.add('applied');
        setTimeout(() => pill.classList.remove('applied'), 1200);
        promptInput.focus();
      });
      container.appendChild(pill);
    }
  }
})();

// ── Collapsible panels ────────────────────────────────────────────────────────
(function initCollapsibles() {
  const sweetOpen = localStorage.getItem('shader-sweeteners-open') === 'true';
  sweetenersPanel.hidden = !sweetOpen;
  sweetenersArrow.classList.toggle('open', sweetOpen);

  sweetenersToggle.addEventListener('click', () => {
    const isHidden = sweetenersPanel.hidden;
    sweetenersPanel.hidden = !isHidden;
    sweetenersArrow.classList.toggle('open', isHidden);
    localStorage.setItem('shader-sweeteners-open', isHidden ? 'true' : 'false');
  });

  const historyOpen = localStorage.getItem('shader-history-open') !== 'false';
  historyList.hidden = !historyOpen;
  historyControls.hidden = !historyOpen;
  historyArrow.classList.toggle('open', historyOpen);

  historyToggle.addEventListener('click', () => {
    const isHidden = historyList.hidden;
    historyList.hidden = !isHidden;
    historyControls.hidden = !isHidden;
    historyArrow.classList.toggle('open', isHidden);
    localStorage.setItem('shader-history-open', isHidden ? 'true' : 'false');
  });

  historySearch.addEventListener('input', () => {
    _historySearchQuery = historySearch.value.trim();
    renderHistory();
  });

  historySortBtn.addEventListener('click', () => {
    if (_historySort === null)       _historySort = 'asc';
    else if (_historySort === 'asc') _historySort = 'desc';
    else                             _historySort = null;
    const icons = { null: 'mingcute:az-sort-ascending-letters-line', asc: 'mingcute:az-sort-ascending-letters-line', desc: 'mingcute:za-sort-descending-letters-line' };
    const titles = { null: 'Sort A→Z', asc: 'Sort A→Z', desc: 'Sort Z→A' };
    historySortBtn.innerHTML = `<iconify-icon icon="${icons[_historySort]}" width="14" height="14"></iconify-icon>`;
    historySortBtn.title = titles[_historySort];
    historySortBtn.classList.toggle('active', _historySort !== null);
    renderHistory();
  });

  historyTagFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = historyTagFilterMenu.hidden;
    historyTagFilterMenu.hidden = !isHidden;
    if (!isHidden) return;
    renderTagFilterMenu();
  });

  document.addEventListener('click', () => { historyTagFilterMenu.hidden = true; });
  historyTagFilterMenu.addEventListener('click', (e) => e.stopPropagation());

  thinkingToggle.addEventListener('click', () => {
    const hidden = thinkingContent.hidden;
    thinkingContent.hidden = !hidden;
    thinkingArrow.classList.toggle('open', hidden);
  });

  const descOpen = localStorage.getItem('shader-description-open') !== 'false';
  descriptionArrow.classList.toggle('open', descOpen);
  explanationEl.hidden = !descOpen;

  descriptionToggle.addEventListener('click', () => {
    const isHidden = explanationEl.hidden;
    explanationEl.hidden = !isHidden;
    descriptionArrow.classList.toggle('open', isHidden);
    localStorage.setItem('shader-description-open', isHidden ? 'true' : 'false');
  });
})();

// ── Recent prompts tracking ───────────────────────────────────────────────────
const RECENT_PROMPTS_KEY = 'shader-recent-random-prompts';
const MAX_RECENT = 6;

function getRecentPrompts() {
  try { return JSON.parse(localStorage.getItem(RECENT_PROMPTS_KEY) || '[]'); }
  catch { return []; }
}

function pushRecentPrompt(prompt) {
  const recent = getRecentPrompts().filter(p => p !== prompt);
  recent.unshift(prompt);
  localStorage.setItem(RECENT_PROMPTS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

randomBtn.addEventListener('click', async () => {
  if (generating) return;
  randomBtn.innerHTML = '<iconify-icon icon="mingcute:loading-3-line" width="18" height="18" class="spin"></iconify-icon>';
  randomBtn.disabled = true;

  // Reset thinking panel to loading state
  thinkingPanel.hidden = true;
  thinkingContent.hidden = false;
  thinkingContent.textContent = '';
  thinkingLabel.textContent = 'Thinking…';
  thinkingSpinner.hidden = false;
  thinkingArrow.classList.add('open');

  try {
    const recentPrompts = getRecentPrompts();
    const res = await fetch('/api/random-prompt', {
      method: 'POST',
      headers: providerHeaders(),
      body: JSON.stringify({ recentPrompts }),
    });
    const { prompt, reasoning, error } = await res.json();
    if (error) { showError(error); return; }

    if (reasoning) {
      thinkingContent.textContent = reasoning;
      thinkingPanel.hidden = false;
      thinkingLabel.textContent = 'Thought';
      thinkingSpinner.hidden = true;
      thinkingContent.hidden = true;
      thinkingArrow.classList.remove('open');
    }

    pushRecentPrompt(prompt);
    promptInput.value = prompt;
    promptInput.focus();
  } catch (err) {
    showError('Failed to get random prompt: ' + err.message);
  } finally {
    randomBtn.innerHTML = '<iconify-icon icon="mingcute:shuffle-2-line" width="18" height="18"></iconify-icon>';
    randomBtn.disabled = false;
  }
});

// ── Enhance prompt ───────────────────────────────────────────────────────────
enhancePromptBtn.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (!prompt || generating) return;
  enhancePromptBtn.innerHTML = '<iconify-icon icon="mingcute:loading-3-line" width="18" height="18" class="spin"></iconify-icon>';
  enhancePromptBtn.disabled = true;
  try {
    const res = await fetch('/api/enhance-prompt', {
      method: 'POST',
      headers: providerHeaders(),
      body: JSON.stringify({ prompt }),
    });
    const { prompt: enhanced, error } = await res.json();
    if (error) { showError(error); return; }
    promptInput.value = enhanced;
    promptInput.focus();
  } catch (err) {
    showError('Failed to enhance prompt: ' + err.message);
  } finally {
    enhancePromptBtn.innerHTML = '<iconify-icon icon="mingcute:sparkles-line" width="18" height="18"></iconify-icon>';
    enhancePromptBtn.disabled = false;
  }
});

// ── Enhance shader ───────────────────────────────────────────────────────────
enhanceShaderBtn.addEventListener('click', () => {
  const wasHidden = enhanceShaderPopover.hidden;
  enhanceShaderPopover.hidden = !wasHidden;
  if (wasHidden) {
    enhanceShaderInput.value = '';
    enhanceShaderInput.focus();
  }
});

document.addEventListener('click', (e) => {
  if (!enhanceShaderWrap.contains(e.target)) {
    enhanceShaderPopover.hidden = true;
  }
});

async function doEnhanceShader() {
  const instruction = enhanceShaderInput.value.trim();
  const src = monacoEditor.getValue().trim();
  if (!src || generating) return;

  enhanceShaderPopover.hidden = true;
  generating = true;
  enhanceShaderBtn.disabled = true;
  enhanceShaderBtn.innerHTML = '<iconify-icon icon="mingcute:loading-3-line" width="16" height="16" style="animation:spin 1s linear infinite"></iconify-icon>';
  clearError();
  setStatus('Enhancing shader…');
  streamContent.innerHTML = '';
  terminalBadge.textContent = 'enhancing…';
  streamPreview.style.display = 'block';
  explanationEl.textContent = '';

  const enhanceMsg = instruction
    ? `Enhance this shader: ${instruction}. Preserve the overall visual character. Output only the updated shader inside a \`\`\`glsl fence — nothing before it.`
    : 'Improve the visual quality and detail of this shader — richer colors, finer details, more impressive motion — without changing its overall subject or theme. Output only the updated shader inside a \`\`\`glsl fence — nothing before it.';

  let streamBuf = '';
  await generateShader(enhanceMsg, src, null, {
    onDelta(text) {
      streamBuf += text;
      streamContent.innerHTML = glslHighlight(streamBuf.slice(-800)) + '<span class="t-cursor"></span>';
      streamContent.scrollTop = streamContent.scrollHeight;
    },
    async onDone(shader) {
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';

      if (!shader) {
        showError('AI did not return a valid shader. Try again.');
        finishEnhanceShader();
        return;
      }

      const err = tryCompile(shader);
      if (err) {
        showError('Enhanced shader has errors: ' + parseGLSLError(err), true);
        monacoEditor.setValue(shader);
        finishEnhanceShader();
        return;
      }

      currentShader = shader;
      monacoEditor.setValue(shader);
      renderer.resetTime();
      const uniforms = extractUniforms(shader);
      controls.rebuild(uniforms);
      pushUndoState(shader, controls.getValues());
      if (activeHistoryItem) {
        activeHistoryItem.shader = shader;
        activeHistoryItem.params = controls.getValues();
        saveHistory();
      }
      setStatus('Shader enhanced — ' + uniforms.length + ' parameter(s)');
      finishEnhanceShader();
    },
    onError(msg) {
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';
      showError(msg);
      finishEnhanceShader();
    },
  });

  function finishEnhanceShader() {
    generating = false;
    enhanceShaderBtn.disabled = false;
    enhanceShaderBtn.innerHTML = '<iconify-icon icon="mingcute:ai-line" width="16" height="16"></iconify-icon>';
  }
}

enhanceShaderSubmit.addEventListener('click', doEnhanceShader);
enhanceShaderInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doEnhanceShader();
  if (e.key === 'Escape') { enhanceShaderPopover.hidden = true; }
});

// ── New session ──────────────────────────────────────────────────────────────
newSessionBtn.addEventListener('click', () => {
  promptInput.value = '';
  explanationEl.textContent = '';
  descriptionSection.hidden = true;
  clearError();
  currentShader = null;
  activeHistoryItem = null;
  activePresetIndex = null;
  referenceImage = null;
  imagePreviewWrap.style.display = 'none';
  imagePreviewThumb.src = '';
  monacoEditor.setValue('// Your GLSL shader will appear here after generation.\n// You can also write or paste a shader directly and click Compile.');
  compileBtn.classList.remove('dirty');
  controls.rebuild([]);
  renderer.compile(''); // revert to blank default
  setResolution(1.0);
  setStatus('Ready — enter a prompt and click Generate');
  // Deselect any active history item
  document.querySelectorAll('.history-item.active').forEach(el => el.classList.remove('active'));
  renderPresets();
  promptInput.focus();
});

// ── Compiler logs ─────────────────────────────────────────────────────────────
const LOG_ICONS = {
  success: '<iconify-icon icon="mingcute:check-line" width="14" height="14"></iconify-icon>',
  error:   '<iconify-icon icon="mingcute:close-circle-line" width="14" height="14"></iconify-icon>',
  info:    '<iconify-icon icon="mingcute:information-line" width="14" height="14"></iconify-icon>',
};

function appendLog(type, msg) {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);

  const empty = logListEl.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry log-entry--${type}`;
  entry.innerHTML =
    `<span class="log-icon">${LOG_ICONS[type]}</span>` +
    `<span class="log-time">${ts}</span>` +
    `<span class="log-msg">${msg}</span>`;
  logListEl.appendChild(entry);
  compilerLogsEl.scrollTop = compilerLogsEl.scrollHeight;
}

function clearLogs() {
  logListEl.innerHTML = '<div class="log-empty">No compiler output yet.</div>';
}

function setEditorMode(mode) {
  const isLogs = mode === 'logs';
  glslEditorEl.hidden = isLogs;
  compilerLogsEl.hidden = !isLogs;
  clearLogsBtn.hidden = !isLogs;
  adaptBtnWrap.hidden = isLogs;
  enhanceShaderWrap.hidden = isLogs;
  compileBtn.hidden = isLogs;
  editorModeSelect.value = mode;
  if (isLogs) monacoEditor.layout();
}

clearLogsBtn.addEventListener('click', clearLogs);

editorModeSelect.addEventListener('change', () => {
  setEditorMode(editorModeSelect.value);
  if (editorModeSelect.value === 'editor') monacoEditor.layout();
});

clearLogs();

// ── Compile ──────────────────────────────────────────────────────────────────
compileBtn.addEventListener('click', () => {
  const src = monacoEditor.getValue();
  appendLog('info', 'Compiling…');
  const err = renderer.compile(src);
  if (!err) {
    currentShader = src;
    activePresetIndex = null;
    renderer.resetTime();
    const uniforms = extractUniforms(src);
    controls.rebuild(uniforms);
    pushUndoState(src, controls.getValues());
    setStatus('Compiled — ' + uniforms.length + ' parameter(s)');
    appendLog('success', 'Compiled — ' + uniforms.length + ' parameter(s)');
    renderPresets();
  } else {
    appendLog('error', parseGLSLError(err));
  }
});

// ── Adapt shader for app ─────────────────────────────────────────────────────
adaptBtn.addEventListener('click', async () => {
  const src = monacoEditor.getValue().trim();
  if (!src || generating) return;

  generating = true;
  adaptBtn.disabled = true;
  adaptBtn.title = 'Adapting…';
  adaptBtn.innerHTML = '<iconify-icon icon="mingcute:loading-3-line" width="16" height="16" style="animation:spin 1s linear infinite"></iconify-icon>';
  clearError();
  setStatus('Asking Claude to adapt shader…');
  streamContent.innerHTML = '';
  terminalBadge.textContent = 'adapting…';
  streamPreview.style.display = 'block';
  explanationEl.textContent = '';

  const adaptPrompt = `Adapt the shader below to work with this WebGL2 app. Transform it so it meets ALL of these requirements exactly:
- First line: #version 300 es
- Second line: precision highp float;
- Declare these uniforms (keep any others that exist): uniform float u_time;  uniform vec2 u_resolution;
- Output variable must be: out vec4 fragColor; — replace any use of gl_FragColor with fragColor
- Replace any texture2D() calls with texture()
- Replace any varying/attribute keywords with the WebGL2 equivalents (in/out)
- Remove any WebGL1-only extensions or constructs
- Add // @param annotations for every tunable uniform so they appear as controls, e.g.: uniform float u_speed; // @param label:"Speed" min:0.0 max:2.0 default:1.0 step:0.01
- Preserve the visual intent and animation as closely as possible
Output only the adapted shader inside a \`\`\`glsl fence — nothing before it.`;

  let streamBuf = '';
  await generateShader(adaptPrompt, src, null, {
    onDelta(text) {
      streamBuf += text;
      streamContent.innerHTML = glslHighlight(streamBuf.slice(-800)) + '<span class="t-cursor"></span>';
      streamContent.scrollTop = streamContent.scrollHeight;
    },
    async onDone(shader, explanation) {
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';

      if (!shader) {
        showError('Claude did not return a valid shader. Try again.');
        finishAdapt();
        return;
      }

      const err = tryCompile(shader);
      if (err) {
        showError('Adapted shader has errors: ' + parseGLSLError(err), true);
        monacoEditor.setValue(shader);
        finishAdapt();
        return;
      }

      currentShader = shader;
      monacoEditor.setValue(shader);
      renderer.resetTime();
      const uniforms = extractUniforms(shader);
      controls.rebuild(uniforms);
      pushUndoState(shader, controls.getValues());
      if (explanation) explanationEl.textContent = explanation;
      setStatus('Shader adapted — ' + uniforms.length + ' parameter(s)');
      finishAdapt();
    },
    onError(msg) {
      streamPreview.style.display = 'none';
      streamContent.innerHTML = '';
      showError(msg);
      finishAdapt();
    },
  });

  function finishAdapt() {
    generating = false;
    adaptBtn.disabled = false;
    adaptBtn.title = 'Adapt for App';
    adaptBtn.innerHTML = '<iconify-icon icon="mingcute:magic-2-line" width="16" height="16"></iconify-icon>';
  }
});

// ── Pause / Reset ────────────────────────────────────────────────────────────
pauseBtn.addEventListener('click', () => {
  const paused = renderer.togglePause();
  pauseBtn.innerHTML = paused
    ? '<iconify-icon icon="mingcute:play-fill" width="16" height="16"></iconify-icon> Resume'
    : '<iconify-icon icon="mingcute:pause-fill" width="16" height="16"></iconify-icon> Pause';
});

resetBtn.addEventListener('click', () => renderer.resetTime());

// ── Fullscreen ───────────────────────────────────────────────────────────────
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    canvasWrap.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.innerHTML = document.fullscreenElement
    ? '<iconify-icon icon="mingcute:fullscreen-exit-line" width="16" height="16"></iconify-icon> Exit'
    : '<iconify-icon icon="mingcute:fullscreen-line" width="16" height="16"></iconify-icon> Fullscreen';
});

// ── History ───────────────────────────────────────────────────────────────────
function saveHistory() {
  try { localStorage.setItem('shader-history', JSON.stringify(history)); } catch (_) {}
}

function addHistory(prompt) {
  history.unshift({ prompt, shader: currentShader, name: null, params: {}, presets: [], tags: [] });
  if (history.length > 20) history.pop();
  activeHistoryItem = history[0];
  activePresetIndex = null;
  renderHistory();
  saveHistory();
  renderPresets();
}

function getAllTags() {
  const s = new Set();
  for (const item of history) for (const t of (item.tags || [])) s.add(t);
  return [...s].sort();
}

function renderTagFilterMenu() {
  const tags = getAllTags();
  historyTagFilterMenu.innerHTML = '';
  if (!tags.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-filter-empty';
    empty.textContent = 'No tags yet';
    historyTagFilterMenu.appendChild(empty);
  } else {
    for (const tag of tags) {
      const row = document.createElement('label');
      row.className = 'tag-filter-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = _historyTagFilter.has(tag);
      cb.addEventListener('change', () => {
        if (cb.checked) _historyTagFilter.add(tag);
        else _historyTagFilter.delete(tag);
        updateFilterBadge();
        renderHistory();
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(tag));
      historyTagFilterMenu.appendChild(row);
    }
  }
  const clearBtn = document.createElement('button');
  clearBtn.className = 'tag-filter-clear';
  clearBtn.textContent = 'Clear filters';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _historyTagFilter.clear();
    updateFilterBadge();
    renderHistory();
    renderTagFilterMenu();
  });
  historyTagFilterMenu.appendChild(clearBtn);
}

function updateFilterBadge() {
  const n = _historyTagFilter.size;
  historyFilterBadge.hidden = n === 0;
  historyFilterBadge.textContent = n;
}

function _startTagInput(tagsRow, item) {
  const existing = tagsRow.querySelector('.history-tag-input');
  if (existing) { existing.focus(); return; }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'history-tag-input';
  input.placeholder = 'tag…';
  input.maxLength = 24;
  const addBtn = tagsRow.querySelector('.history-tag-add');
  tagsRow.insertBefore(input, addBtn);
  input.focus();
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const val = input.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (val && !(item.tags || []).includes(val)) {
      item.tags = item.tags || [];
      item.tags.push(val);
      saveHistory();
    }
    renderHistory();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderHistory();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', cancel);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renderHistory() {
  const q = _historySearchQuery.toLowerCase();
  const filtered = history.filter(item => {
    if (q) {
      const name = (item.name || item.prompt).toLowerCase();
      if (!name.includes(q)) return false;
    }
    if (_historyTagFilter.size) {
      const itemTags = item.tags || [];
      for (const t of _historyTagFilter) if (!itemTags.includes(t)) return false;
    }
    return true;
  });

  if (_historySort) {
    filtered.sort((a, b) => {
      const na = (a.name || a.prompt).toLowerCase();
      const nb = (b.name || b.prompt).toLowerCase();
      return _historySort === 'asc' ? na.localeCompare(nb) : nb.localeCompare(na);
    });
  }

  document.getElementById('history-count').textContent = history.length ? `(${history.length})` : '';
  historyList.innerHTML = '';

  for (let fi = 0; fi < filtered.length; fi++) {
    const item = filtered[fi];
    const i = history.indexOf(item);
    const li = document.createElement('li');
    li.className = 'history-item' + (activeHistoryItem === item ? ' active' : '');

    // ── Name column ──────────────────────────────────────────────────────────
    const nameCol = document.createElement('div');
    nameCol.className = 'history-item-name';

    const displayName = item.name || (item.prompt.slice(0, 60) + (item.prompt.length > 60 ? '…' : ''));
    const span = document.createElement('span');
    span.className = 'history-label';
    span.textContent = displayName;
    nameCol.appendChild(span);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-delete-btn';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h8M5 3V2h2v1M4.5 3v6M7.5 3v6M3 3l.5 7h5l.5-7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = item.name || item.prompt.slice(0, 40) + '…';
      if (!confirm(`Delete "${label}"?`)) return;
      if (activeHistoryItem === item) activeHistoryItem = null;
      history.splice(i, 1);
      saveHistory();
      renderHistory();
    });
    nameCol.appendChild(deleteBtn);
    li.appendChild(nameCol);

    // ── Tags column ──────────────────────────────────────────────────────────
    const tagsCol = document.createElement('div');
    tagsCol.className = 'history-item-tags';

    for (const tag of (item.tags || [])) {
      const chip = document.createElement('span');
      chip.className = 'history-tag-chip';
      chip.textContent = tag;
      chip.addEventListener('click', (e) => e.stopPropagation());
      const del = document.createElement('button');
      del.className = 'history-tag-chip-del';
      del.textContent = '×';
      del.title = 'Remove tag';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        item.tags = item.tags.filter(t => t !== tag);
        saveHistory();
        renderHistory();
      });
      chip.appendChild(del);
      tagsCol.appendChild(chip);
    }

    const addTagBtn = document.createElement('button');
    addTagBtn.className = 'history-tag-add';
    addTagBtn.textContent = '+';
    addTagBtn.title = 'Add tag';
    addTagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _startTagInput(tagsCol, item);
    });
    tagsCol.appendChild(addTagBtn);
    li.appendChild(tagsCol);

    // ── Interactions ─────────────────────────────────────────────────────────
    li.addEventListener('click', () => {
      promptInput.value = item.prompt;
      if (item.shader) {
        activeHistoryItem = item;
        activePresetIndex = null;
        currentShader = item.shader;
        monacoEditor.setValue(item.shader);
        renderer.compile(item.shader);
        renderer.resetTime();
        setResolution(item.renderScale ?? 1.0);
        const uniforms = extractUniforms(item.shader);
        controls.rebuild(uniforms, item.params || {});
        pushUndoState(item.shader, controls.getValues());
        renderPresets();
        document.querySelectorAll('.history-item.active').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
      }
    });

    nameCol.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'history-rename-input';
      input.value = item.name || item.prompt;
      nameCol.replaceChild(input, span);
      input.select();
      let settled = false;
      const commit = () => {
        if (settled) return;
        settled = true;
        const val = input.value.trim();
        item.name = val || null;
        saveHistory();
        renderHistory();
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        renderHistory();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        ev.stopPropagation();
      });
      input.addEventListener('blur', cancel);
      input.addEventListener('click', (ev) => ev.stopPropagation());
    });

    historyList.appendChild(li);
  }

  renderTagFilterMenu();
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  themeToggle.innerHTML = next === 'light'
    ? '<iconify-icon icon="mingcute:sun-line" width="18" height="18"></iconify-icon>'
    : '<iconify-icon icon="mingcute:moon-line" width="18" height="18"></iconify-icon>';
  localStorage.setItem('shader-theme', next);
  if (window.monaco) {
    monaco.editor.setTheme(next === 'light' ? 'vs' : 'vs-dark');
  }
});

// ── Image upload ──────────────────────────────────────────────────────────────
imageBtn.addEventListener('click', () => imageUpload.click());

imageUpload.addEventListener('change', () => {
  const file = imageUpload.files[0];
  if (!file) return;

  const img = new Image();
  const objectUrl = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    // Downscale to max 1024px on longest side for reasonable payload size
    const maxDim = 1024;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
      else       { w = Math.round(w * maxDim / h); h = maxDim; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];
    referenceImage = { base64, mediaType: 'image/jpeg' };
    imagePreviewThumb.src = dataUrl;
    imagePreviewWrap.style.display = 'block';
  };
  img.src = objectUrl;
  imageUpload.value = '';
});

imageRemoveBtn.addEventListener('click', () => {
  referenceImage = null;
  imagePreviewWrap.style.display = 'none';
  imagePreviewThumb.src = '';
});

// ── Editor resize (drag top edge of bottom panel) ────────────────────────────
editorResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-h')) || 280;

  editorResizeHandle.classList.add('dragging');
  document.body.classList.add('resizing-v');

  function onMove(e) {
    const delta = startY - e.clientY;
    const newH = Math.min(600, Math.max(80, startH + delta));
    document.documentElement.style.setProperty('--editor-h', newH + 'px');
    monacoEditor.layout();
  }

  function onUp() {
    editorResizeHandle.classList.remove('dragging');
    document.body.classList.remove('resizing-v');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    monacoEditor.layout();
    const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--editor-h'));
    localStorage.setItem('shader-editor-h', h);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ── Edit / remove parameters ──────────────────────────────────────────────────
let paramsEditMode = false;

function enterParamsEditMode() {
  paramsEditMode = true;
  paramEditBtn.classList.add('edit-active');
  paramsEditBar.hidden = false;
  userParams.classList.add('edit-mode');

  // Prepend a checkbox to each control row
  for (const row of userParams.querySelectorAll('.control-row[data-uniform-name]')) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'param-edit-check';
    cb.addEventListener('change', updateEditCount);
    row.prepend(cb);

    // Clicking the row also toggles the checkbox
    row.addEventListener('click', rowEditClick);
  }
  updateEditCount();
}

function exitParamsEditMode() {
  paramsEditMode = false;
  paramEditBtn.classList.remove('edit-active');
  paramsEditBar.hidden = true;
  userParams.classList.remove('edit-mode');

  for (const row of userParams.querySelectorAll('.control-row[data-uniform-name]')) {
    row.querySelector('.param-edit-check')?.remove();
    row.classList.remove('marked');
    row.removeEventListener('click', rowEditClick);
  }
}

function rowEditClick(e) {
  if (e.target.classList.contains('param-edit-check')) return; // checkbox handles itself
  const cb = this.querySelector('.param-edit-check');
  if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
}

function updateEditCount() {
  const total   = userParams.querySelectorAll('.control-row[data-uniform-name]').length;
  const checked = userParams.querySelectorAll('.param-edit-check:checked').length;
  paramsEditCount.textContent = checked === 0
    ? `${total} parameter${total !== 1 ? 's' : ''}`
    : `${checked} of ${total} selected`;
  paramsEditDelete.disabled = checked === 0;

  // Sync .marked class
  for (const row of userParams.querySelectorAll('.control-row[data-uniform-name]')) {
    const cb = row.querySelector('.param-edit-check');
    row.classList.toggle('marked', !!cb?.checked);
  }
}

// Auto-exit edit mode whenever the parameter list is rebuilt
const _rebuildOrig = controls.rebuild.bind(controls);
controls.rebuild = (...args) => {
  if (paramsEditMode) exitParamsEditMode();
  _rebuildOrig(...args);
};

paramCopyBtn.addEventListener('click', () => {
  const values = controls.getValues();
  navigator.clipboard.writeText(JSON.stringify(values, null, 2)).then(() => {
    const icon = paramCopyBtn.querySelector('iconify-icon');
    icon.setAttribute('icon', 'mingcute:check-line');
    paramCopyBtn.style.color = 'var(--green)';
    setTimeout(() => {
      icon.setAttribute('icon', 'mingcute:copy-2-line');
      paramCopyBtn.style.color = '';
    }, 1500);
  });
});

paramEditBtn.addEventListener('click', () => {
  if (paramsEditMode) exitParamsEditMode();
  else enterParamsEditMode();
});

paramSaveBtn.addEventListener('click', () => {
  if (!activeHistoryItem) return;
  activeHistoryItem.shader = currentShader || monacoEditor.getValue();
  activeHistoryItem.params = controls.getValues();
  saveHistory();
  showSaveIndicator();
  paramSaveBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6.5l2.5 2.5 5.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  paramSaveBtn.style.color = 'var(--green)';
  setTimeout(() => {
    paramSaveBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="1.5" width="3.5" height="2.5" stroke="currentColor" stroke-width="1.1"/><rect x="2.5" y="6" width="7" height="4" rx="0.5" stroke="currentColor" stroke-width="1.1"/></svg>';
    paramSaveBtn.style.color = '';
  }, 1200);
});

paramsEditCancel.addEventListener('click', exitParamsEditMode);

manualSaveBtn.addEventListener('click', () => {
  const prompt = promptInput.value.trim();
  const shader = monacoEditor.getValue();
  if (!activeHistoryItem) {
    if (!shader.trim()) return;
    history.unshift({ prompt, shader, name: null, params: controls.getValues(), presets: [], tags: [] });
    if (history.length > 20) history.pop();
    activeHistoryItem = history[0];
    renderHistory();
    renderPresets();
  } else {
    activeHistoryItem.prompt = prompt;
    activeHistoryItem.shader = shader;
    currentShader = shader;
    activeHistoryItem.params = controls.getValues();
  }
  saveHistory();
  showSaveIndicator();
  manualSaveBtn.innerHTML = '<iconify-icon icon="mingcute:check-line" width="18" height="18"></iconify-icon>';
  manualSaveBtn.style.color = 'var(--green)';
  setTimeout(() => {
    manualSaveBtn.innerHTML = '<iconify-icon icon="mingcute:save-2-line" width="18" height="18"></iconify-icon>';
    manualSaveBtn.style.color = '';
  }, 1200);
});

paramsEditDelete.addEventListener('click', async () => {
  const selected = [];
  for (const row of userParams.querySelectorAll('.control-row[data-uniform-name]')) {
    if (row.querySelector('.param-edit-check')?.checked) {
      selected.push(row.dataset.uniformName);
    }
  }
  if (!selected.length || !currentShader) return;

  exitParamsEditMode();
  const prevStatus = statusBar.textContent;
  setStatus(`Removing ${selected.length} parameter${selected.length > 1 ? 's' : ''}…`);
  paramEditBtn.disabled = true;

  try {
    const res = await fetch('/api/remove-params', {
      method: 'POST',
      headers: providerHeaders(),
      body: JSON.stringify({ paramNames: selected, currentShader }),
    });
    const { shader, error } = await res.json();
    if (error) { showError(error); return; }
    if (!shader) { showError('Claude did not return a valid shader.'); return; }

    const err = tryCompile(shader);
    if (err) {
      showError('Shader after removal has errors: ' + parseGLSLError(err));
      monacoEditor.setValue(shader);
      return;
    }

    currentShader = shader;
    monacoEditor.setValue(shader);
    renderer.resetTime();
    const uniforms = extractUniforms(shader);
    controls.rebuild(uniforms);
    setStatus(`Removed ${selected.length} parameter${selected.length > 1 ? 's' : ''} — ${uniforms.length} remaining`);
  } catch (e) {
    showError('Failed to remove parameters: ' + e.message);
  } finally {
    paramEditBtn.disabled = false;
  }
});

// ── Add parameter ─────────────────────────────────────────────────────────────
paramAddDropdown.hidden = true;

function closeParamDropdown() {
  paramAddDropdown.hidden = true;
  paramAddBtn.classList.remove('open');
}

function updateRowRemoveBtns() {
  const rows = paramRowsEl.querySelectorAll('.param-row');
  rows.forEach(r => {
    r.querySelector('.param-row-remove').style.visibility = rows.length > 1 ? 'visible' : 'hidden';
  });
}

function addParamRow(focus = false) {
  const row = document.createElement('div');
  row.className = 'param-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g. Speed, Color…';
  input.autocomplete = 'off';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAddParam(); }
    if (e.key === 'Escape') { closeParamDropdown(); }
    e.stopPropagation();
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'param-row-remove';
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    row.remove();
    updateRowRemoveBtns();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  paramRowsEl.appendChild(row);
  updateRowRemoveBtns();
  if (focus) input.focus();
}

function resetParamRows() {
  paramRowsEl.innerHTML = '';
  addParamRow(false);
}

paramAddBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !paramAddDropdown.hidden;
  paramAddDropdown.hidden = open;
  paramAddBtn.classList.toggle('open', !open);
  if (!open) {
    resetParamRows();
    paramRowsEl.querySelector('input').focus();
  }
});

document.addEventListener('click', (e) => {
  if (!paramAddBtn.contains(e.target) && !paramAddDropdown.contains(e.target)) {
    closeParamDropdown();
  }
});

paramAddRowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addParamRow(true);
});

async function doAddParam() {
  const inputs = [...paramRowsEl.querySelectorAll('input')];
  const names = inputs.map(i => i.value.trim()).filter(Boolean);
  if (!names.length) { inputs[0]?.focus(); return; }
  if (!currentShader) {
    showError('Generate or compile a shader first before adding parameters.');
    return;
  }

  closeParamDropdown();
  paramAddBtn.disabled = true;

  let shader = currentShader;
  let added = 0;

  for (const name of names) {
    setStatus(`Adding "${name}"… (${added + 1} of ${names.length})`);
    try {
      const res = await fetch('/api/add-param', {
        method: 'POST',
        headers: providerHeaders(),
        body: JSON.stringify({ paramName: name, currentShader: shader }),
      });
      const { shader: next, error } = await res.json();
      if (error) { showError(error); break; }
      if (!next) { showError('Claude did not return a valid shader.'); break; }
      const err = tryCompile(next);
      if (err) { showError(`"${name}" added but shader has errors: ` + parseGLSLError(err)); break; }
      shader = next;
      added++;
    } catch (e) {
      showError('Failed to add parameter: ' + e.message);
      break;
    }
  }

  if (added > 0) {
    currentShader = shader;
    monacoEditor.setValue(shader);
    renderer.resetTime();
    const uniforms = extractUniforms(shader);
    controls.rebuild(uniforms);
    pushUndoState(shader, controls.getValues());
    setStatus(`${added} parameter(s) added — ${uniforms.length} total`);
  }

  paramAddBtn.disabled = false;
}

paramAddSubmit.addEventListener('click', doAddParam);

// ── Left panel resize (drag right edge of left panel) ────────────────────────
leftResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 280;

  leftResizeHandle.classList.add('dragging');
  document.body.classList.add('resizing-h');

  function onMove(e) {
    const newW = Math.min(500, Math.max(160, startW + (e.clientX - startX)));
    document.documentElement.style.setProperty('--left-w', newW + 'px');
  }

  function onUp() {
    leftResizeHandle.classList.remove('dragging');
    document.body.classList.remove('resizing-h');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-w'));
    localStorage.setItem('shader-left-w', w);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ── Left panel collapse toggle (horizontal) ──────────────────────────────────
leftCollapseBtn.addEventListener('click', () => {
  const collapsed = mainEl.classList.toggle('left-collapsed');
  localStorage.setItem('shader-left-collapsed', collapsed ? '1' : '0');
  monacoEditor?.layout();
});

// ── Prompt section collapse (vertical, within left panel) ────────────────────
if (localStorage.getItem('shader-prompt-collapsed') === '1') {
  leftPanel.classList.add('prompt-collapsed');
}

promptSectionToggle.addEventListener('click', () => {
  const collapsed = leftPanel.classList.toggle('prompt-collapsed');
  localStorage.setItem('shader-prompt-collapsed', collapsed ? '1' : '0');
});

// ── Right panel resize (drag left edge of right panel) ───────────────────────
rightResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w')) || 240;

  rightResizeHandle.classList.add('dragging');
  document.body.classList.add('resizing-h');

  function onMove(e) {
    const delta = startX - e.clientX;
    const newW = Math.min(500, Math.max(160, startW + delta));
    document.documentElement.style.setProperty('--right-w', newW + 'px');
  }

  function onUp() {
    rightResizeHandle.classList.remove('dragging');
    document.body.classList.remove('resizing-h');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w'));
    localStorage.setItem('shader-right-w', w);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ── Export ────────────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle('open');
  exportMenu.classList.add('open-up');
});

document.addEventListener('click', () => exportMenu.classList.remove('open'));

document.querySelectorAll('[data-export]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.remove('open');
    openExportModal(item.dataset.export);
  });
});

function exportPNG() {
  if (!currentShader) {
    showError('Generate a shader first before exporting.');
    return;
  }
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shader.png';
  a.click();
}

function openExportModal(format) {
  if (format === 'png') { exportPNG(); return; }

  if (!currentShader) {
    showError('Generate a shader first before exporting.');
    return;
  }

  const uniforms = extractUniforms(currentShader);
  const values = controls.getValues();
  const descriptors = uniforms.map(u => ({ ...u, default: values[u.name] ?? u.default }));

  let code = '';
  let title = '';

  switch (format) {
    case 'glsl':    code = exportGLSL(currentShader);              title = 'Raw GLSL';         break;
    case 'vanilla': code = exportVanillaJS(currentShader, descriptors); title = 'Vanilla JS';   break;
    case 'react':   code = exportReact(currentShader, descriptors);     title = 'React Component'; break;
    case 'svelte':  code = exportSvelte(currentShader, descriptors);    title = 'Svelte Component'; break;
  }

  modalTitle.textContent = title;
  modalCode.textContent = code;

  if (window.Prism) {
    const lang = format === 'react' ? 'jsx'
      : format === 'svelte' ? 'markup'
      : format === 'glsl' ? 'glsl'
      : 'javascript';
    modalCode.className = `language-${lang}`;
    Prism.highlightElement(modalCode);
  }

  modal.classList.add('open');
}

modalClose.addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

modalCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(modalCode.textContent).then(() => {
    modalCopy.textContent = 'Copied!';
    setTimeout(() => { modalCopy.textContent = 'Copy'; }, 1500);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusBar.textContent = msg;
  statusBar.classList.toggle('loading', msg.endsWith('…'));
}

function showError(msg, fixable = false) {
  errorBanner.innerHTML = '';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'error-msg';
  msgSpan.textContent = msg;
  errorBanner.appendChild(msgSpan);

  if (fixable) {
    const fixBtn = document.createElement('button');
    fixBtn.className = 'error-fix-btn';
    fixBtn.textContent = 'Fix';
    fixBtn.addEventListener('click', () => onErrorFixClick(fixBtn));
    errorBanner.appendChild(fixBtn);
  }

  errorBanner.style.display = 'flex';
  setStatus('Error');
}

function clearError() {
  errorBanner.innerHTML = '';
  errorBanner.style.display = 'none';
}

async function onErrorFixClick(fixBtn) {
  if (generating) return;
  const src = monacoEditor.getValue().trim();
  if (!src) return;

  const rawErr = renderer.compile(src);
  if (!rawErr) { clearError(); return; }

  generating = true;
  fixBtn.disabled = true;
  fixBtn.textContent = 'Fixing…';
  setStatus('Asking ' + getModelLabel() + ' to fix…');

  const fixed = await autoFix(src, rawErr);

  generating = false;

  if (fixed) {
    currentShader = fixed;
    monacoEditor.setValue(fixed);
    renderer.resetTime();
    const uniforms = extractUniforms(fixed);
    controls.rebuild(uniforms);
    pushUndoState(fixed, controls.getValues());
    clearError();
    setStatus('Fixed — ' + uniforms.length + ' parameter(s)');
    appendLog('success', 'Auto-fix applied — ' + uniforms.length + ' parameter(s)');
  }
}

function parseGLSLError(raw) {
  const m = raw.match(/ERROR:\s*\d+:(\d+):\s*(.*)/);
  if (m) return `Line ${m[1]}: ${m[2]}`;
  return raw;
}

// ── GLSL syntax highlighter (terminal stream) ─────────────────────────────────
const _GLSL_KEYWORDS = new Set(['if','else','for','while','do','break','continue','return','discard',
  'struct','in','out','inout','uniform','const','precision','highp','mediump','lowp',
  'layout','location','varying','attribute']);
const _GLSL_TYPES = new Set(['void','bool','int','uint','float','double',
  'vec2','vec3','vec4','bvec2','bvec3','bvec4','ivec2','ivec3','ivec4',
  'uvec2','uvec3','uvec4','mat2','mat3','mat4',
  'mat2x2','mat2x3','mat2x4','mat3x2','mat3x3','mat3x4','mat4x2','mat4x3','mat4x4',
  'sampler2D','sampler3D','samplerCube','sampler2DArray','isampler2D','usampler2D']);
const _GLSL_BUILTINS = new Set(['sin','cos','tan','asin','acos','atan','sinh','cosh','tanh',
  'pow','exp','log','exp2','log2','sqrt','inversesqrt','abs','sign','floor','trunc',
  'round','ceil','fract','mod','min','max','clamp','mix','step','smoothstep',
  'length','distance','dot','cross','normalize','reflect','refract','faceforward',
  'texture','texture2D','textureCube','texelFetch','textureSize',
  'dFdx','dFdy','fwidth','gl_FragCoord','gl_Position','gl_VertexID',
  'fragColor','main','matrixCompMult','transpose','inverse','determinant']);

function glslHighlight(code) {
  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    // Line comment
    if (code[i] === '/' && code[i+1] === '/') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = n;
      out += `<span class="t-comment">${esc(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }
    // Block comment
    if (code[i] === '/' && code[i+1] === '*') {
      let end = code.indexOf('*/', i+2);
      if (end === -1) end = n - 2;
      else end += 2;
      out += `<span class="t-comment">${esc(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }
    // Preprocessor directive
    if (code[i] === '#') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = n;
      out += `<span class="t-preprocessor">${esc(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }
    // Number literal
    if (/\d/.test(code[i]) || (code[i] === '.' && i+1 < n && /\d/.test(code[i+1]))) {
      let j = i;
      while (j < n && /[\d.eEfFxXa-fA-FuU]/.test(code[j])) j++;
      out += `<span class="t-number">${esc(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // Identifier / keyword / type / builtin
    if (/[a-zA-Z_]/.test(code[i])) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (_GLSL_KEYWORDS.has(word))      out += `<span class="t-keyword">${esc(word)}</span>`;
      else if (_GLSL_TYPES.has(word))    out += `<span class="t-type">${esc(word)}</span>`;
      else if (_GLSL_BUILTINS.has(word)) out += `<span class="t-builtin">${esc(word)}</span>`;
      else                               out += esc(word);
      i = j;
      continue;
    }
    out += esc(code[i]);
    i++;
  }
  return out;
}

// ── Prompt textarea height persistence ───────────────────────────────────────
const savedPromptH = localStorage.getItem('shader-prompt-h');
if (savedPromptH) promptInput.style.height = savedPromptH + 'px';

new ResizeObserver(() => {
  localStorage.setItem('shader-prompt-h', promptInput.offsetHeight);
}).observe(promptInput);

setStatus('Ready — enter a prompt and click Generate');

// ── Settings ──────────────────────────────────────────────────────────────────
const settingsBtn         = document.getElementById('settings-btn');
const settingsModal       = document.getElementById('settings-modal');
const settingsCloseBtn    = document.getElementById('settings-close');
const settingAutoCompile  = document.getElementById('setting-auto-compile');
const settingCompileDelay = document.getElementById('setting-compile-delay');
const compileDelayLabel   = document.getElementById('compile-delay-label');
const autoCompileDelayRow = document.getElementById('auto-compile-delay-row');
const settingRestoreSession = document.getElementById('setting-restore-session');
const settingFontSize     = document.getElementById('setting-font-size');
const fontSizeLabel       = document.getElementById('font-size-label');
const settingAccentColor  = document.getElementById('setting-accent-color');
const accentPresetsEl     = document.getElementById('accent-presets');
const settingsTabs          = document.querySelectorAll('.settings-tab');
const settingKeyAnthropicInput = document.getElementById('setting-api-key-anthropic');
const settingKeyAnthropicSave  = document.getElementById('setting-api-key-anthropic-save');
const settingKeyOpenaiInput    = document.getElementById('setting-api-key-openai');
const settingKeyOpenaiSave     = document.getElementById('setting-api-key-openai-save');
const settingKeyGeminiInput    = document.getElementById('setting-api-key-gemini');
const settingKeyGeminiSave     = document.getElementById('setting-api-key-gemini-save');
const settingLocalUrl          = document.getElementById('setting-local-url');
const settingLocalUrlSave      = document.getElementById('setting-local-url-save');
const settingLocalModel        = document.getElementById('setting-local-model');
const settingLocalModelSave    = document.getElementById('setting-local-model-save');

function hexToHsl(hex) {
  let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0, l = (max+min)/2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  return [h*360, s*100, l*100];
}

function hslToHex(h, s, l) {
  h/=360; s/=100; l/=100;
  const hue2rgb = (p,q,t) => {
    if(t<0)t+=1; if(t>1)t-=1;
    if(t<1/6)return p+(q-p)*6*t;
    if(t<1/2)return q;
    if(t<2/3)return p+(q-p)*(2/3-t)*6;
    return p;
  };
  let r,g,b;
  if(s===0){ r=g=b=l; } else {
    const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return '#'+[r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

function applyAccentColor(hex) {
  const [h,s,l] = hexToHsl(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-h', hslToHex(h, s, Math.min(l+14, 90)));
  root.style.setProperty('--accent-d', hslToHex(h, s, Math.max(l-14, 8)));
  const bmcBtn = document.getElementById('bmc-wbtn');
  if (bmcBtn) bmcBtn.style.backgroundColor = hex;
}

// Apply accent to BMC widget once it's injected into the DOM
new MutationObserver((_, obs) => {
  const bmcBtn = document.getElementById('bmc-wbtn');
  if (bmcBtn) {
    bmcBtn.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    obs.disconnect();
  }
}).observe(document.body, { childList: true, subtree: true });

function syncAccentSwatches(hex) {
  accentPresetsEl.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === hex.toLowerCase());
  });
}

function loadSettings() {
  const accent = localStorage.getItem('shader-accent') || '#7c3aed';
  applyAccentColor(accent);
  settingAccentColor.value = accent;
  syncAccentSwatches(accent);

  const autoCompile = localStorage.getItem('shader-auto-compile') === 'true';
  settingAutoCompile.checked = autoCompile;
  autoCompileDelayRow.classList.toggle('enabled', autoCompile);

  const compileDelay = parseInt(localStorage.getItem('shader-compile-delay') || '800');
  settingCompileDelay.value = compileDelay;
  compileDelayLabel.textContent = compileDelay + ' ms';

  const restoreSession = localStorage.getItem('shader-restore-session') !== 'false';
  settingRestoreSession.checked = restoreSession;

  const fontSize = parseInt(localStorage.getItem('shader-editor-fontsize') || '12');
  settingFontSize.value = fontSize;
  fontSizeLabel.textContent = fontSize + ' px';
  if (monacoEditor) monacoEditor.updateOptions({ fontSize });

  function maskKey(k) { return k ? k.slice(0, 8) + '…' : ''; }
  settingKeyAnthropicInput.value = maskKey(getApiKey('anthropic'));
  settingKeyOpenaiInput.value    = maskKey(getApiKey('openai'));
  settingKeyGeminiInput.value    = maskKey(getApiKey('gemini'));

  const storedUrl = localStorage.getItem('shader-local-url') || '';
  settingLocalUrl.value = storedUrl || 'http://localhost:1234/v1';

  const storedModel = localStorage.getItem('shader-local-model') || '';
  settingLocalModel.value = storedModel;

  syncProviderSwitcher();
}

loadSettings();

// Auto-compile debounce wired into Monaco's existing change listener
let _autoCompileTimer = null;
monacoEditor.onDidChangeModelContent(() => {
  if (!settingAutoCompile.checked) return;
  clearTimeout(_autoCompileTimer);
  const delay = parseInt(settingCompileDelay.value);
  _autoCompileTimer = setTimeout(() => {
    const src = monacoEditor.getValue().trim();
    if (!src) return;
    appendLog('info', 'Auto-compiling…');
    const err = renderer.compile(src);
    if (!err) {
      currentShader = src;
      compileBtn.classList.remove('dirty');
      clearError();
      const uniforms = extractUniforms(src);
      controls.rebuild(uniforms, controls.getValues());
      appendLog('success', 'Compiled — ' + uniforms.length + ' parameter(s)');
    } else {
      showError(parseGLSLError(err));
      appendLog('error', parseGLSLError(err));
    }
  }, delay);
});

settingsBtn.addEventListener('click', () => settingsModal.classList.add('open'));
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.remove('open'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

settingsTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    settingsTabs.forEach(t => t.classList.remove('settings-tab--active'));
    tab.classList.add('settings-tab--active');
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.add('settings-pane--hidden'));
    document.getElementById('settings-pane-' + tab.dataset.tab).classList.remove('settings-pane--hidden');
  });
});

settingAccentColor.addEventListener('input', () => {
  const hex = settingAccentColor.value;
  applyAccentColor(hex);
  syncAccentSwatches(hex);
  localStorage.setItem('shader-accent', hex);
});

accentPresetsEl.querySelectorAll('.accent-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    const hex = sw.dataset.color;
    settingAccentColor.value = hex;
    applyAccentColor(hex);
    syncAccentSwatches(hex);
    localStorage.setItem('shader-accent', hex);
  });
});

settingAutoCompile.addEventListener('change', () => {
  const on = settingAutoCompile.checked;
  autoCompileDelayRow.classList.toggle('enabled', on);
  localStorage.setItem('shader-auto-compile', on);
});

settingCompileDelay.addEventListener('input', () => {
  const v = settingCompileDelay.value;
  compileDelayLabel.textContent = v + ' ms';
  localStorage.setItem('shader-compile-delay', v);
});

settingRestoreSession.addEventListener('change', () => {
  localStorage.setItem('shader-restore-session', settingRestoreSession.checked);
});

settingFontSize.addEventListener('input', () => {
  const size = parseInt(settingFontSize.value);
  fontSizeLabel.textContent = size + ' px';
  localStorage.setItem('shader-editor-fontsize', size);
  if (monacoEditor) monacoEditor.updateOptions({ fontSize: size });
});

// ── Provider switcher ────────────────────────────────────────────────────────
const PROVIDER_LABELS = { anthropic: 'Anthropic Claude', openai: 'OpenAI GPT-4o', gemini: 'Google Gemini', local: 'Local model' };

function syncProviderSwitcher() {
  const active = localStorage.getItem('shader-provider') || 'anthropic';
  providerSwitcher.querySelectorAll('.provider-btn').forEach(btn => {
    const p = btn.dataset.provider;
    const configured = hasCredential(p);
    btn.hidden = !configured;
    btn.classList.toggle('provider-btn--active', p === active);
  });
}

providerSwitcher.addEventListener('click', e => {
  const btn = e.target.closest('.provider-btn');
  if (!btn) return;
  const provider = btn.dataset.provider;
  localStorage.setItem('shader-provider', provider);
  syncProviderSwitcher();
  setStatus('Using ' + PROVIDER_LABELS[provider]);
});

// ── Per-provider key saves ────────────────────────────────────────────────────
function makeKeySaver(provider, inputEl) {
  return function save() {
    const raw = inputEl.value.trim();
    if (!raw || raw.endsWith('…')) return;
    localStorage.setItem('shader-api-key-' + provider, raw);
    inputEl.value = raw.slice(0, 8) + '…';
    syncProviderSwitcher();
    setStatus(provider.charAt(0).toUpperCase() + provider.slice(1) + ' key saved');
  };
}

function makeKeyFocusHandler(provider, inputEl) {
  return function() {
    const stored = getApiKey(provider);
    if (stored) inputEl.value = stored;
  };
}

[
  ['anthropic', settingKeyAnthropicInput, settingKeyAnthropicSave],
  ['openai',    settingKeyOpenaiInput,    settingKeyOpenaiSave],
  ['gemini',    settingKeyGeminiInput,    settingKeyGeminiSave],
].forEach(([provider, input, saveBtn]) => {
  const save = makeKeySaver(provider, input);
  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  input.addEventListener('focus', makeKeyFocusHandler(provider, input));
});

function saveLocalUrl() {
  const raw = settingLocalUrl.value.trim();
  if (!raw) return;
  localStorage.setItem('shader-local-url', raw);
  syncProviderSwitcher();
  setStatus('Server URL saved');
}
settingLocalUrlSave.addEventListener('click', saveLocalUrl);
settingLocalUrl.addEventListener('keydown', e => { if (e.key === 'Enter') saveLocalUrl(); });

function saveLocalModel() {
  const raw = settingLocalModel.value.trim();
  if (raw) localStorage.setItem('shader-local-model', raw);
  else     localStorage.removeItem('shader-local-model');
  setStatus('Model name saved');
}
settingLocalModelSave.addEventListener('click', saveLocalModel);
settingLocalModel.addEventListener('keydown', e => { if (e.key === 'Enter') saveLocalModel(); });

// ── Help modal ────────────────────────────────────────────────────────────────
helpBtn.addEventListener('click', () => helpModal.classList.add('open'));
helpClose.addEventListener('click', () => helpModal.classList.remove('open'));
helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.classList.remove('open'); });
