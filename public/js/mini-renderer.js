// Minimal WebGL2 renderer for shader thumbnails/previews — shared by the
// showcase, community feed, and profile pages so none of them re-implement
// full-screen-triangle boilerplate.

const VERT_SRC = `#version 300 es
void main() {
  vec2 verts[3];
  verts[0] = vec2(-1.0, -1.0);
  verts[1] = vec2( 3.0, -1.0);
  verts[2] = vec2(-1.0,  3.0);
  gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`;

function mkShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

export function createRenderer(canvas, fragSrc) {
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;

  const vert = mkShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const frag = mkShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vert || !frag) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('Program link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uRes  = gl.getUniformLocation(prog, 'u_resolution');

  let rafId = null;
  const t0 = performance.now();

  function resize() {
    const w = canvas.clientWidth  * devicePixelRatio | 0;
    const h = canvas.clientHeight * devicePixelRatio | 0;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    resize();
    if (uTime)  gl.uniform1f(uTime, (performance.now() - t0) / 1000);
    if (uRes)   gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function start() { if (!rafId) frame(); }
  function stop()  { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  return { start, stop, gl };
}
