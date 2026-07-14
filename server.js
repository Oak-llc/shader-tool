import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import { shaderRoutes } from './lib/shaders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// better-auth needs the raw request stream, so it must be mounted before express.json().
app.all('/api/auth/*', toNodeHandler(auth));

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

app.use('/api', shaderRoutes);

const SYSTEM_PROMPT = `You are an expert GLSL shader author. You will be given a description and must write a complete WebGL2 fragment shader.

STRICT OUTPUT FORMAT:
1. Begin your response with \`\`\`glsl (exactly that, lowercase, no spaces before or after).
2. Immediately follow with the shader code starting on the next line.
3. Close with \`\`\` on its own line.
4. After the closing \`\`\` write 2-3 sentences of technical explanation.
Do not output any text before the opening \`\`\`glsl fence.

Shader requirements:
- First line: #version 300 es
- Second line: precision highp float;
- Declare exactly:
    uniform float u_time;
    uniform vec2 u_resolution;
- For every additional tunable uniform, put an @param annotation inline on the same line:
    uniform float u_speed; // @param label:"Speed" min:0.0 max:2.0 default:0.12 step:0.01
    uniform float u_zoom;  // @param label:"Zoom" min:0.5 max:10.0 default:3.0 step:0.1
    uniform vec3 u_color;  // @param label:"Color" default:[1.0,0.5,0.2]
    uniform bool u_glow;   // @param label:"Glow" default:true
- Output: out vec4 fragColor;
- No external textures or samplers
- Must produce visible, animated output at t=0
- Always declare at least one vec3 color uniform with a @param annotation and wire it into the output color. Choose a default that matches the visual (e.g. primary hue, glow color, base tint). If the shader has distinct color regions, expose each as a separate vec3 uniform.
- Write high-quality, visually impressive GLSL`;

const RANDOM_PROMPT_SYSTEM = `You generate creative shader prompts for a GLSL shader tool. Output a single shader description — no preamble, no explanation, just the description itself.

CRITICAL RULE: Every response must come from a DIFFERENT category and feel completely unlike any prompt you've recently generated. Never produce two prompts that share the same visual metaphor, setting, or technique in sequence.

Rotate unpredictably across ALL of these categories — each call should land in a totally different one:
- Abstract mathematics: strange attractors, Lissajous curves, reaction-diffusion, cellular automata, escape-time fractals, iterated function systems
- Elemental nature: lava lamp blobs, underwater caustics, storm lightning, sand dunes, arctic ice, coastal foam, lightning strikes
- Cosmic: neutron star pulsar, black hole accretion disk, interstellar gas cloud, solar flare, dark matter halo, comet trail
- Sci-fi: holographic data sphere, alien bio-luminescence, quantum interference pattern, warp field, crashed ship reactor core, drone swarm formation
- Retro/lo-fi: oscilloscope Lissajous, VHS glitch, analog signal noise, CRT phosphor bloom, punched-card grid, dot-matrix rain
- Architectural: brutalist concrete grid at dusk, Islamic geometric mosaic, stained glass cathedral rose window, brutalist tower facade, tilework labyrinth
- Biological: mycelium branching network, neuron firing cascade, blood vessel tree, slime mold path-finding, coral polyp colony
- Musical: sound wave interference, drum machine step sequencer, equalizer bars, vinyl groove cross-section, speaker membrane vibration
- Material: polished obsidian with light caustics, frosted glass diffusion, oil film iridescence, liquid mercury surface, carbon fiber weave
- Psychedelic: DMT geometric entity, fractal recursion portal, chromatic aberration bloom, recursive mirror tunnel, pulsing mandala

Be specific about visual style, color palette, and motion. Keep it to 2-4 sentences.`;


const PROVIDER_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  gemini:    'gemini-2.0-flash',
  local:     'local-model',
};

const OPENAI_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

function getConfig(req) {
  const provider  = req.headers['x-provider'] || 'anthropic';
  const apiKey    = req.headers['x-api-key']    || process.env.ANTHROPIC_API_KEY || '';
  const localUrl  = req.headers['x-local-url']  || 'http://localhost:1234/v1';
  const localModel= req.headers['x-local-model'];
  const model     = provider === 'local'
    ? (localModel || PROVIDER_MODELS.local)
    : PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
  const baseURL   = provider === 'local' ? localUrl : OPENAI_BASE_URLS[provider];
  return { provider, apiKey, model, baseURL };
}

function anthropicClient(apiKey) {
  return new Anthropic({ apiKey });
}

function openaiClient(apiKey, baseURL) {
  return new OpenAI({ apiKey: apiKey || 'local', baseURL });
}

function extractShader(text) {
  let m = text.match(/```(?:glsl|GLSL)\s*\r?\n([\s\S]*?)```/);
  if (m) return split(m[1], text, m.index + m[0].length);

  m = text.match(/```[^\n]*\r?\n(#version[\s\S]*?)```/);
  if (m) return split(m[1], text, m.index + m[0].length);

  m = text.match(/```[^\n]*\r?\n([\s\S]*?void main[\s\S]*?)```/);
  if (m) return split(m[1], text, m.index + m[0].length);

  const vIdx = text.indexOf('#version');
  if (vIdx !== -1) {
    const raw = text.slice(vIdx);
    const endMatch = raw.match(/\n\n[A-Z][^\n{};]*\n/);
    const shader = endMatch ? raw.slice(0, endMatch.index).trim() : raw.trim();
    const explanation = endMatch ? raw.slice(endMatch.index).trim() : '';
    return { shader, explanation };
  }

  return { shader: null, explanation: text };
}

function split(shaderRaw, fullText, afterFenceIdx) {
  return {
    shader: shaderRaw.trim(),
    explanation: fullText.slice(afterFenceIdx).trim(),
  };
}

// ── Streaming generate ────────────────────────────────────────────────────────

app.post('/api/generate', async (req, res) => {
  const { prompt, currentShader, imageBase64, imageMediaType } = req.body;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const { provider, apiKey, model, baseURL } = getConfig(req);

  if (provider !== 'local' && !apiKey) {
    return res.status(401).json({ error: 'No API key provided. Add one in Settings.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const textPrompt = currentShader
    ? `${prompt}\n\nCurrent shader to iterate on:\n\`\`\`glsl\n${currentShader}\n\`\`\``
    : prompt;

  if (provider === 'anthropic') {
    const userContent = imageBase64
      ? [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/png', data: imageBase64 } },
          { type: 'text', text: textPrompt },
        ]
      : textPrompt;

    try {
      const stream = anthropicClient(apiKey).messages.stream({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      let fullText = '';
      stream.on('text', (text) => {
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
      });
      stream.on('finalMessage', () => {
        const { shader, explanation } = extractShader(fullText);
        res.write(`data: ${JSON.stringify({ type: 'done', shader, explanation })}\n\n`);
        res.end();
      });
      stream.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
      });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  } else {
    // OpenAI-compatible (openai / gemini / local)
    const userContent = imageBase64
      ? [
          { type: 'image_url', image_url: { url: `data:${imageMediaType || 'image/png'};base64,${imageBase64}` } },
          { type: 'text', text: textPrompt },
        ]
      : textPrompt;

    try {
      const stream = openaiClient(apiKey, baseURL).chat.completions.stream({
        model,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });

      let fullText = '';
      let thinkingStreamed = '';
      for await (const chunk of stream) {
        // Incremental reasoning (models that stream thinking token-by-token)
        const thinkingDelta = chunk.choices[0]?.delta?.reasoning_content;
        if (thinkingDelta) {
          thinkingStreamed += thinkingDelta;
          res.write(`data: ${JSON.stringify({ type: 'thinking', text: thinkingDelta })}\n\n`);
        }
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
        }
      }

      // Fallback: some servers (e.g. LM Studio) only populate reasoning_content
      // on the final assembled message rather than in individual delta chunks.
      if (!thinkingStreamed) {
        const finalMsg = await stream.finalMessage();
        const reasoning = finalMsg.choices?.[0]?.message?.reasoning_content;
        if (reasoning) {
          res.write(`data: ${JSON.stringify({ type: 'thinking', text: reasoning })}\n\n`);
        }
      }

      const { shader, explanation } = extractShader(fullText);
      res.write(`data: ${JSON.stringify({ type: 'done', shader, explanation })}\n\n`);
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── Non-streaming helpers ─────────────────────────────────────────────────────

async function callAI(req, systemPrompt, userPrompt, maxTokens = 8192) {
  const { provider, apiKey, model, baseURL } = getConfig(req);

  if (provider === 'anthropic') {
    const msg = await anthropicClient(apiKey).messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return { text: msg.content[0].text, reasoning: null };
  } else {
    const msg = await openaiClient(apiKey, baseURL).chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const msg0 = msg.choices[0].message;
    return {
      text: msg0.content || msg0.reasoning_content || '',
      reasoning: msg0.content ? (msg0.reasoning_content || null) : null,
    };
  }
}

const ENHANCE_PROMPT_SYSTEM = `You are an expert GLSL shader prompt engineer. Your job is to take a simple shader description and rewrite it into a vivid, specific prompt that will produce the most visually impressive GLSL shader that faithfully represents what the user described.

Enrich the prompt by adding concrete details about:
- A specific rendering technique (e.g. domain-warped fBm noise, SDF primitives with smooth blending, Voronoi cell decomposition, polar-coordinate mapping)
- A rich named color palette (e.g. deep cobalt and bioluminescent cyan, warm amber fading to ash, neon magenta on near-black)
- Animation character (e.g. slow breathing pulse, turbulent fluid drift, rapid crystalline fracturing)
- Atmospheric or textural detail that elevates the visual quality

Rules:
- Do NOT change the subject or theme — enrich HOW it looks, not WHAT it is
- Keep the output to 3-5 sentences maximum
- Output ONLY the enhanced prompt — no preamble, no explanation, no surrounding quotes`;

const RANDOM_MOTIONS   = ['spiraling','pulsating','crystalline','molten','recursive','organic','glitching','iridescent','turbulent','fracturing','blooming','dissolving','refracting','oscillating','cascading','warping','shattering','flowing','flickering','expanding'];
const RANDOM_PALETTES  = ['deep crimson and gold','electric cyan on black','monochromatic green','sunset magenta and orange','arctic blue and white','bioluminescent teal','acid yellow and violet','copper and verdigris','neon pink on near-black','ember orange fading to ash','silver and indigo','pale lavender and dark maroon'];
const RANDOM_MOODS     = ['eerie and liminal','joyful and kinetic','cold and mechanical','warm and meditative','chaotic and dense','sparse and minimal','ancient and eroded','hyper-synthetic','dreamlike and soft','sharp and industrial'];
const RANDOM_SUBJECTS  = ['a microscopic surface','an astronomical phenomenon','an architectural interior','a living organism','a data structure','a physical material','an audio waveform','a mathematical surface','a weather system','a geological formation','a circuit board','a textile or fabric','a fluid in motion','a decaying object','a glowing energy field'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

app.post('/api/random-prompt', async (req, res) => {
  const { provider, apiKey } = getConfig(req);
  if (provider !== 'local' && !apiKey) {
    return res.status(401).json({ error: 'No API key provided. Add one in Settings.' });
  }
  try {
    const recentPrompts = Array.isArray(req.body.recentPrompts) ? req.body.recentPrompts.slice(0, 6) : [];
    const seed = `[seed:${Math.random().toString(36).slice(2,8)}] Motion: ${pick(RANDOM_MOTIONS)}. Palette: ${pick(RANDOM_PALETTES)}. Mood: ${pick(RANDOM_MOODS)}. Subject: ${pick(RANDOM_SUBJECTS)}.`;
    const avoidClause = recentPrompts.length > 0
      ? ` Avoid anything resembling:\n${recentPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '';
    const userMsg = `Give me a random shader prompt.${avoidClause}\n\n${seed}`;
    const { text, reasoning } = await callAI(req, RANDOM_PROMPT_SYSTEM, userMsg, 4096);
    const prompt = text.trim();
    res.json({ prompt, reasoning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/enhance-prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const { provider, apiKey } = getConfig(req);
  if (provider !== 'local' && !apiKey) {
    return res.status(401).json({ error: 'No API key provided. Add one in Settings.' });
  }
  try {
    const { text: enhanced } = await callAI(req, ENHANCE_PROMPT_SYSTEM, prompt, 400);
    res.json({ prompt: enhanced.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/add-param', async (req, res) => {
  const { paramName, currentShader } = req.body;
  if (!paramName?.trim() || !currentShader?.trim()) {
    return res.status(400).json({ error: 'paramName and currentShader are required' });
  }
  const { provider, apiKey } = getConfig(req);
  if (provider !== 'local' && !apiKey) {
    return res.status(401).json({ error: 'No API key provided. Add one in Settings.' });
  }

  const prompt = `Add a new tunable parameter called "${paramName}" to the GLSL shader below.

Rules:
1. Infer the best GLSL type from the name (e.g. "Color" or "Tint" → vec3, "Speed" or "Intensity" → float, "Enable" or "Show" → bool, "Offset" or "Direction" → vec2).
2. Declare it as a uniform with a @param annotation: uniform <type> u_${paramName.toLowerCase().replace(/\s+/g, '_')}; // @param label:"${paramName}" min:... max:... default:... step:...
3. Wire it into the shader logic meaningfully — don't just declare it unused.
4. Keep all existing uniforms and visual intent intact.
5. Output only the updated shader inside a \`\`\`glsl fence — no explanation before the fence.`;

  try {
    const { text: full } = await callAI(req, SYSTEM_PROMPT, `${prompt}\n\nCurrent shader:\n\`\`\`glsl\n${currentShader}\n\`\`\``);
    const { shader, explanation } = extractShader(full);
    res.json({ shader, explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/remove-params', async (req, res) => {
  const { paramNames, currentShader } = req.body;
  if (!Array.isArray(paramNames) || !paramNames.length || !currentShader?.trim()) {
    return res.status(400).json({ error: 'paramNames (array) and currentShader are required' });
  }
  const { provider, apiKey } = getConfig(req);
  if (provider !== 'local' && !apiKey) {
    return res.status(401).json({ error: 'No API key provided. Add one in Settings.' });
  }

  const list = paramNames.map(n => `• ${n}`).join('\n');
  const prompt = `Remove the following uniforms from the GLSL shader and all references to them in the code. Preserve the overall visual intent — replace each removed uniform with a reasonable hardcoded constant so the shader still compiles and looks good.\n\nUniforms to remove:\n${list}\n\nOutput only the updated shader inside a \`\`\`glsl fence — nothing before it.`;

  try {
    const { text: full } = await callAI(req, SYSTEM_PROMPT, `${prompt}\n\nCurrent shader:\n\`\`\`glsl\n${currentShader}\n\`\`\``);
    const { shader, explanation } = extractShader(full);
    res.json({ shader, explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/app', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'app.html'));
});

app.get('/learn', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'learn.html'));
});

app.get('/showcase', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'showcase.html'));
});

app.get('/u/:username', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'profile.html'));
});

app.get('/s/:id', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'shader-view.html'));
});

app.listen(port, () => {
  console.log(`Shader Tool running at http://localhost:${port}`);
});
