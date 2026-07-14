<img src="./assets/app-screenshot.png" height="300px" />

# shader-tool

A GLSL fragment AI shader editor with real-time WebGL2 preview, interactive
parameter controls, and export to React, Svelte, Vanilla JS, or raw GLSL.

---

## Features

- ✨ **AI shader generation** — type something like "neon lava lamp but make it
  anxious" and watch it materialize in real time
- 🤖 **Multiple AI providers** — Anthropic, OpenAI, Gemini, or your local model
  (LM Studio, Ollama) — use whatever GPU god you prefer
- ⚡ **Real-time WebGL2 preview** — the shader compiles and runs _as the AI is
  still writing it_
- 🔧 **Auto-fix** — when a shader breaks, it automatically gets sent back to the
  AI with a "hey, you broke it" note; usually comes back fixed
- 🎛️ **Interactive parameter controls** — sliders, color pickers, toggles, and
  vector inputs that actually do something, powered by `@param` annotations
- 🎬 **Parameter animation** — hit the play button on any slider and watch it
  oscillate on its own like a screensaver from the future
- 🍬 **Prompt sweeteners** — one-click injections of technique, theme, and color
  ideas when you're staring at a blank prompt box
- 💬 **Prompt enhancement** — AI rewrites your vague idea into something
  surprisingly vivid before sending it off
- 📝 **Monaco editor** — the VS Code editor, but for your shaders, with full
  GLSL syntax highlighting and auto-compile on save
- 🕰️ **History** — last 20 shaders saved across sessions, searchable, taggable,
  and renameable so you can find "the good one"
- 💾 **Presets** — save and switch between named parameter configurations
  without touching the code
- ↩️ **Undo / redo** — 50-step state stack (Cmd/Ctrl+Z), because you will
  absolutely need it
- 📦 **Export** — GLSL · Vanilla JS · React · Svelte — drop it into whatever
  you're building
- 🔄 **Shader adapter** — paste in a shader from Shadertoy or wherever; it gets
  converted to the app's conventions automatically
- 🖼️ **Showcase** — a gallery of example shaders you can one-click import and
  remix
- 🔭 **Fullscreen mode** and resolution quality presets for when you want to
  stare at it like art
- 🌗 **Dark / light theme** with a customizable accent color, because of course

---

## Quick Start

```bash
git clone <repo-url>
cd shader-tool
npm install
cp .env.example .env   # add your API key (see Providers below)
npm run dev            # auto-restarts on file change
```

Open `http://localhost:2000` (or the port set in `.env`).

For production: `npm start`.

---

## Providers

| Provider                | Key in `.env` / Settings UI           | Notes                                           |
| ----------------------- | ------------------------------------- | ----------------------------------------------- |
| **Anthropic** (default) | `ANTHROPIC_API_KEY`                   | Claude models; supports extended thinking       |
| **OpenAI**              | Set in Settings UI                    | GPT-4o and newer models                         |
| **Google Gemini**       | Set in Settings UI                    | Gemini 2.x models                               |
| **Local**               | Set base URL + model name in Settings | LM Studio, Ollama, any OpenAI-compatible server |

Only `ANTHROPIC_API_KEY` is read from `.env`. All other keys are entered in the
Settings panel and stored in `localStorage`.

---

## Shader Conventions

Every generated shader follows these constraints:

```glsl
#version 300 es
precision highp float;

uniform float u_time;       // elapsed seconds
uniform vec2 u_resolution;  // canvas size in pixels

out vec4 fragColor;

void main() { ... }
```

Tunable uniforms use `// @param` annotations:

```glsl
uniform float u_speed;  // @param label:"Speed" min:0.0 max:2.0 default:0.5 step:0.01
uniform vec3  u_color;  // @param label:"Color" default:[1.0, 0.4, 0.1]
uniform bool  u_glow;   // @param label:"Glow" default:true
```

The `u_` prefix is stripped when generating control labels and export prop
names.

---

## Architecture

```
server.js              Express backend; proxies Anthropic / OpenAI APIs via SSE
lib/
  auth.js              better-auth instance (MongoDB adapter, anonymous + username plugins)
  shaders.js           Shader persistence API — save/delete/feed/like, mounted at /api
public/
  index.html           Landing page (provider selection)
  app.html             Main editor
  showcase.html        Example shader gallery + community feed tab
  learn.html           Educational resources
  profile.html         Public profile feed (/u/:username)
  shader-view.html     Shareable, remixable shader permalink (/s/:id)
  js/
    app.js             Main controller — wires all UI, manages state, orchestrates flows
    renderer.js        WebGL2 wrapper (full-screen triangle, uniform binding, animation loop)
    mini-renderer.js   Lightweight WebGL2 renderer shared by showcase/profile/permalink thumbnails
    parser.js          Extracts uniform + @param metadata from GLSL source
    controls.js        Builds interactive parameter UI from uniform descriptors
    exporters.js       Generates Vanilla JS / React / Svelte component code
    ai.js              SSE client for streaming shader generation
    auth.js            better-auth client — silent anonymous sign-in + username claiming widget
```

## Accounts & profiles

Every visitor is signed in anonymously the moment the editor loads — no form,
no password. Click the account widget in the toolbar to claim a permanent
username, which turns your saved shaders into a public profile at
`/u/<username>`. Use the cloud button next to Save to post the current shader
to your profile; each saved shader gets a shareable, remixable permalink at
`/s/<id>` and can be "remixed" from the Showcase's Community tab or your
profile page, which loads it into the editor and tags your next save as a
remix.

---

## Export Targets

| Format         | What you get                                                             |
| -------------- | ------------------------------------------------------------------------ |
| **GLSL**       | Raw shader source                                                        |
| **Vanilla JS** | Self-contained `createShader()` function with WebGL2 setup               |
| **React**      | Functional component with `useRef` / `useEffect`; props for each uniform |
| **Svelte**     | Svelte 5 component using runes (`$state`, `$props`, `$bindable`)         |

All exports include uniform binding, device pixel ratio handling, and proper
cleanup.

---

## Environment Variables

| Variable            | Default | Description                                   |
| ------------------- | ------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY` | —       | Required when using Anthropic as the provider |
| `PORT`              | `2000`  | HTTP port the server listens on               |
| `MONGODB_URI`       | —       | Required — connection string for accounts/profiles/shaders |
| `BETTER_AUTH_SECRET`| —       | Required — random secret used to sign sessions |
| `BETTER_AUTH_URL`   | —       | Required — base URL the server is reachable at (e.g. `http://localhost:2000`) |
