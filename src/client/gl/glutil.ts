export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = src.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
      throw new Error(`Shader compile error: ${log}\n${numbered}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    out[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name)!;
  }
  return out;
}

export function buffer(gl: WebGL2RenderingContext, target: number, data: ArrayBufferView, usage: number = gl.STATIC_DRAW): WebGLBuffer {
  const b = gl.createBuffer()!;
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

/** Bind a float attribute from the currently bound ARRAY_BUFFER. */
export function attrib(gl: WebGL2RenderingContext, loc: number, size: number, stride = 0, offset = 0, divisor = 0) {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, divisor);
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Shared GLSL: hash noise and 4-tap PCF shadow lookup. */
export const GLSL_COMMON = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
uniform highp sampler2DShadow u_shadow;
uniform float u_shadowOn;
uniform float u_shadowTexel;
float shadowAt(vec4 lc, float ndl) {
  if (u_shadowOn < 0.5) return 1.0;
  vec3 p = lc.xyz / lc.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float bias = 0.0015 + 0.003 * (1.0 - ndl);
  float s = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      s += texture(u_shadow, vec3(p.xy + vec2(x, y) * u_shadowTexel, p.z - bias));
  return s / 9.0;
}
`;
