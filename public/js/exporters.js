// Shared perf boilerplate inlined into every export target (vanilla JS, React,
// Svelte): a DPR-capped resize instead of raw devicePixelRatio, and an
// IntersectionObserver + document.hidden check that pauses the draw loop
// when the canvas is off-screen or the tab is backgrounded. Exported code
// must stay standalone (pasted into an arbitrary project), so this is
// inlined rather than imported from a shared module.
function perfSetupSnippet(indent) {
  return `${indent}const maxDPR = 2;
${indent}let lastW = 0, lastH = 0, lastDPR = 0;
${indent}function resizeIfNeeded() {
${indent}  const dpr = Math.min(devicePixelRatio || 1, maxDPR);
${indent}  const w = Math.floor(canvas.clientWidth * dpr);
${indent}  const h = Math.floor(canvas.clientHeight * dpr);
${indent}  if (w !== lastW || h !== lastH || dpr !== lastDPR) {
${indent}    lastW = w; lastH = h; lastDPR = dpr;
${indent}    canvas.width = w; canvas.height = h;
${indent}  }
${indent}}
${indent}let visible = true;
${indent}const io = new IntersectionObserver((entries) => {
${indent}  visible = entries[0] ? entries[0].isIntersecting : true;
${indent}}, { threshold: 0 });
${indent}io.observe(canvas);`;
}

function perfGuardSnippet(indent, reschedule = "requestAnimationFrame(draw)") {
  return `${indent}if (!visible || document.hidden) { rafId = ${reschedule}; return; }
${indent}resizeIfNeeded();`;
}

function propList(uniforms) {
  return uniforms.map(u => u.name.replace(/^u_/, '')).join(', ');
}

function defaultProps(uniforms) {
  return uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    const def = JSON.stringify(u.default);
    return `  ${propName} = ${def}`;
  }).join(',\n');
}

function propsInterface(uniforms) {
  return uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    const type = u.type === 'bool' ? 'boolean'
      : u.type.startsWith('vec') ? 'number[]'
      : 'number';
    return `  /** ${u.label} */\n  ${propName}?: ${type};`;
  }).join('\n');
}

export function exportGLSL(glsl) {
  return glsl;
}

export function exportVanillaJS(glsl, uniforms) {
  const uniformSetters = uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    if (Array.isArray(u.default)) {
      const n = u.default.length;
      return `    if ('${propName}' in opts) { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform${n}fv(loc, opts.${propName}); }`;
    } else if (u.type === 'bool') {
      return `    if ('${propName}' in opts) { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform1i(loc, opts.${propName} ? 1 : 0); }`;
    } else {
      return `    if ('${propName}' in opts) { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform1f(loc, opts.${propName}); }`;
    }
  }).join('\n');

  const defaults = uniforms.map(u => {
    return `  ${u.name.replace(/^u_/, '')}: ${JSON.stringify(u.default)}`;
  }).join(',\n');

  return `/**
 * Shader — Vanilla JS
 * Usage: const s = createShader(document.getElementById('canvas'), { ${propList(uniforms)} });
 *        s.setUniforms({ speed: 0.5 });
 *        s.destroy();
 */
const FRAG_SRC = ${JSON.stringify(glsl)};

const VERT_SRC = \`#version 300 es
void main() {
  vec2 pos[3];
  pos[0] = vec2(-1.,-1.); pos[1] = vec2(3.,-1.); pos[2] = vec2(-1.,3.);
  gl_Position = vec4(pos[gl_VertexID], 0., 1.);
}\`;

export function createShader(canvas, opts = {}) {
  const defaults = {
${defaults}
  };
  const state = { ...defaults, ...opts };

  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not supported');

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const vert = compile(gl.VERTEX_SHADER, VERT_SRC);
  const frag = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl.createProgram();
  gl.attachShader(prog, vert); gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

${perfSetupSnippet("  ")}

  const startTime = performance.now();
  let rafId;

  function draw() {
${perfGuardSnippet("    ")}
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(prog);

    const t = gl.getUniformLocation(prog, 'u_time');
    if (t) gl.uniform1f(t, (performance.now() - startTime) / 1000);
    const r = gl.getUniformLocation(prog, 'u_resolution');
    if (r) gl.uniform2f(r, gl.drawingBufferWidth, gl.drawingBufferHeight);

    setUniforms(state);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    rafId = requestAnimationFrame(draw);
  }

  function setUniforms(opts) {
${uniformSetters}
  }

  draw();

  return {
    setUniforms(newOpts) { Object.assign(state, newOpts); setUniforms(newOpts); },
    destroy() { cancelAnimationFrame(rafId); io.disconnect(); gl.deleteProgram(prog); },
  };
}
`;
}

export function exportReact(glsl, uniforms) {
  const propsType = uniforms.length > 0 ? `
/**
 * @typedef {Object} ShaderProps
${uniforms.map(u => ` * @property {${u.type.startsWith('vec') ? 'number[]' : u.type === 'bool' ? 'boolean' : 'number'}} [${u.name.replace(/^u_/, '')}] - ${u.label}`).join('\n')}
 * @property {string} [className]
 * @property {React.CSSProperties} [style]
 */` : '';

  const defaultsObj = uniforms.map(u =>
    `  ${u.name.replace(/^u_/, '')}: ${JSON.stringify(u.default)}`
  ).join(',\n');

  const uniformSetters = uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    if (Array.isArray(u.default)) {
      const n = u.default.length;
      return `    setU('${u.name}', (props.${propName} ?? defaults.${propName}), (loc, v) => gl.uniform${n}fv(loc, v));`;
    } else if (u.type === 'bool') {
      return `    setU('${u.name}', (props.${propName} ?? defaults.${propName}), (loc, v) => gl.uniform1i(loc, v ? 1 : 0));`;
    } else {
      return `    setU('${u.name}', (props.${propName} ?? defaults.${propName}), (loc, v) => gl.uniform1f(loc, v));`;
    }
  }).join('\n');

  return `import { useRef, useEffect } from 'react';
${propsType}

const FRAG_SRC = ${JSON.stringify(glsl)};

const VERT_SRC = \`#version 300 es
void main() {
  vec2 pos[3];
  pos[0]=vec2(-1.,-1.); pos[1]=vec2(3.,-1.); pos[2]=vec2(-1.,3.);
  gl_Position=vec4(pos[gl_VertexID],0.,1.);
}\`;

const defaults = {
${defaultsObj}
};

/** @param {ShaderProps} props */
export default function Shader(props) {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl2');
    if (!gl) return;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

${perfSetupSnippet("    ")}

    const startTime = performance.now();
    let rafId;

    const draw = (currentProps) => {
${perfGuardSnippet("      ", "requestAnimationFrame(() => draw(stateRef.current))")}
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(prog);

      const setU = (name, val, fn) => { const loc = gl.getUniformLocation(prog, name); if (loc) fn(loc, val); };
      const t = gl.getUniformLocation(prog, 'u_time');
      if (t) gl.uniform1f(t, (performance.now() - startTime) / 1000);
      const r = gl.getUniformLocation(prog, 'u_resolution');
      if (r) gl.uniform2f(r, gl.drawingBufferWidth, gl.drawingBufferHeight);

${uniformSetters}

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      rafId = requestAnimationFrame(() => draw(stateRef.current));
    };

    stateRef.current = props;
    draw(props);

    return () => { cancelAnimationFrame(rafId); io.disconnect(); gl.deleteProgram(prog); };
  }, []);

  useEffect(() => { stateRef.current = props; }, [props]);

  return (
    <canvas
      ref={canvasRef}
      className={props.className}
      style={{ width: '100%', height: '100%', display: 'block', ...props.style }}
    />
  );
}
`;
}

export function exportSvelte(glsl, uniforms) {
  const propsRunes = uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    return `  let { ${propName} = $bindable(${JSON.stringify(u.default)}) } = $props();`;
  }).join('\n');

  const uniformSetters = uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    if (Array.isArray(u.default)) {
      const n = u.default.length;
      return `    { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform${n}fv(loc, ${propName}); }`;
    } else if (u.type === 'bool') {
      return `    { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform1i(loc, ${propName} ? 1 : 0); }`;
    } else {
      return `    { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) gl.uniform1f(loc, ${propName}); }`;
    }
  }).join('\n');

  const effectStatements = uniforms.map(u => {
    const propName = u.name.replace(/^u_/, '');
    const setter = Array.isArray(u.default)
      ? `gl.uniform${u.default.length}fv(loc, ${propName})`
      : u.type === 'bool'
      ? `gl.uniform1i(loc, ${propName} ? 1 : 0)`
      : `gl.uniform1f(loc, ${propName})`;
    return `  $effect(() => { if (prog) { const loc = gl.getUniformLocation(prog, '${u.name}'); if (loc) ${setter}; } });`;
  }).join('\n');

  return `<script>
  import { onMount } from 'svelte';

${propsRunes}

  let canvas = $state();
  let gl, prog, rafId;

  const FRAG_SRC = ${JSON.stringify(glsl)};
  const VERT_SRC = \`#version 300 es
void main() {
  vec2 pos[3];
  pos[0]=vec2(-1.,-1.); pos[1]=vec2(3.,-1.); pos[2]=vec2(-1.,3.);
  gl_Position=vec4(pos[gl_VertexID],0.,1.);
}\`;

  onMount(() => {
    gl = canvas.getContext('webgl2');
    if (!gl) return;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    }

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

${perfSetupSnippet("    ")}

    const start = performance.now();

    function draw() {
${perfGuardSnippet("      ")}
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(prog);

      const t = gl.getUniformLocation(prog, 'u_time');
      if (t) gl.uniform1f(t, (performance.now() - start) / 1000);
      const r = gl.getUniformLocation(prog, 'u_resolution');
      if (r) gl.uniform2f(r, gl.drawingBufferWidth, gl.drawingBufferHeight);

${uniformSetters}

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      rafId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(rafId);
      io.disconnect();
      if (prog) gl.deleteProgram(prog);
    };
  });

  // Reactive uniform updates when props change
${effectStatements}
</script>

<canvas bind:this={canvas} style="width:100%;height:100%;display:block;" />
`;
}
