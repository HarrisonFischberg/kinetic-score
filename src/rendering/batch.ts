// Instanced SDF shape batch: every primitive (marble, glow, capsule, arc, glyph,
// rounded rect, disc, spark) is one instance of a single quad, so a whole frame
// is a handful of draw calls and nothing allocates per frame.
import * as THREE from 'three';

export const KIND = {
  ball: 0,
  glow: 1,
  capsule: 2,
  arc: 3,
  glyph: 4,
  rect: 5,
  disc: 6,
  spark: 7,
} as const;

const STRIDE = 16;

const vert = /* glsl */ `
attribute vec2 iPos;
attribute vec2 iSize;
attribute vec4 iMisc;   // rot, kind, extra2.x, extra2.y
attribute vec4 iColor;
attribute vec4 iExtra;
varying vec2 vLocal;
varying vec2 vSize;
varying float vKind;
varying vec4 vColor;
varying vec4 vExtra;
varying vec2 vExtra2;
void main() {
  vec2 local = position.xy * iSize;
  float c = cos(iMisc.x);
  float s = sin(iMisc.x);
  vec2 w = iPos + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vLocal = local;
  vSize = iSize;
  vKind = iMisc.y;
  vColor = iColor;
  vExtra = iExtra;
  vExtra2 = iMisc.zw;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 0.0, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform float uAdditive;
varying vec2 vLocal;
varying vec2 vSize;
varying float vKind;
varying vec4 vColor;
varying vec4 vExtra;
varying vec2 vExtra2;

vec4 outCol(vec3 c, float a) {
  // additive layers want premultiplied-looking colour; normal layers straight alpha
  return uAdditive > 0.5 ? vec4(c * a, a) : vec4(c, a);
}

void main() {
  int k = int(vKind + 0.5);
  vec2 p = vLocal;
  if (k == 0) {
    // marble: shaded sphere with swirl, specular highlight and rim light
    float r = vSize.x;
    float l = length(p);
    float aa = fwidth(l) * 1.2;
    float mask = 1.0 - smoothstep(r - aa, r, l);
    if (mask <= 0.0) discard;
    vec2 q = p / r;
    float d2 = clamp(dot(q, q), 0.0, 1.0);
    vec3 n = vec3(q, sqrt(1.0 - d2));
    vec3 L = normalize(vec3(-0.45, 0.65, 0.75));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float spin = vExtra.x;
    vec2 rq = vec2(q.x * cos(spin) - q.y * sin(spin), q.x * sin(spin) + q.y * cos(spin));
    float swirl = sin(rq.x * 5.0 + sin(rq.y * 4.0 + 1.3) * 1.6) * 0.5 + 0.5;
    vec3 base = vColor.rgb;
    vec3 deep = base * 0.35;
    vec3 col = mix(deep, base, 0.35 + 0.65 * diff);
    col = mix(col, base * 1.25 + 0.05, swirl * 0.25 * n.z);
    float spec = pow(clamp(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 28.0);
    col += vec3(spec) * 0.85;
    float rim = pow(1.0 - n.z, 2.5);
    col += base * rim * (0.6 + vExtra.y);
    col += vec3(1.0) * vExtra.y * 0.35; // hit flash
    gl_FragColor = outCol(col, mask * vColor.a);
    return;
  }
  if (k == 1) {
    float d = length(p) / vSize.x;
    float a = exp(-d * d * 3.2) * (1.0 - smoothstep(0.75, 1.0, d));
    gl_FragColor = outCol(vColor.rgb, a * vColor.a);
    return;
  }
  if (k == 2) {
    // capsule centred at origin along x: half length vExtra.x, radius vExtra.y, halo vExtra.z
    float hl = vExtra.x;
    float th = vExtra.y;
    vec2 q = vec2(max(abs(p.x) - hl, 0.0), p.y);
    float dist = length(q) - th;
    float aa = fwidth(dist) * 1.0;
    float core = 1.0 - smoothstep(-aa, aa, dist);
    float inner = 1.0 - smoothstep(0.0, th, length(q));
    float halo = vExtra.z > 0.0 ? exp(-max(dist, 0.0) / max(0.02, vExtra.z) * 2.5) * (1.0 - core) : 0.0;
    vec3 col = vColor.rgb * (0.75 + 0.5 * inner * vExtra.w) + vExtra.w * inner * 0.25;
    float a = max(core, halo * 0.55);
    if (a <= 0.002) discard;
    gl_FragColor = outCol(mix(vColor.rgb, col, core), a * vColor.a);
    return;
  }
  if (k == 3) {
    // arc: radius vExtra.x, half thickness vExtra.y, start vExtra.z, sweep vExtra.w, halo vExtra2.x
    float R = vExtra.x;
    float th = vExtra.y;
    float l = length(p);
    float ang = atan(p.y, p.x) - vExtra.z;
    ang = mod(ang, 6.28318530718);
    float dist;
    if (ang <= vExtra.w) {
      dist = abs(l - R) - th;
    } else {
      vec2 e0 = R * vec2(cos(vExtra.z), sin(vExtra.z));
      vec2 e1 = R * vec2(cos(vExtra.z + vExtra.w), sin(vExtra.z + vExtra.w));
      dist = min(length(p - e0), length(p - e1)) - th;
    }
    float aa = fwidth(dist);
    float core = 1.0 - smoothstep(-aa, aa, dist);
    float halo = vExtra2.x > 0.0 ? exp(-max(dist, 0.0) / max(0.02, vExtra2.x) * 2.5) * (1.0 - core) : 0.0;
    float inner = 1.0 - smoothstep(0.0, th, abs(l - R));
    vec3 col = vColor.rgb * (0.8 + 0.4 * inner * vExtra2.y) + vExtra2.y * inner * 0.2;
    float a = max(core, halo * 0.55);
    if (a <= 0.002) discard;
    gl_FragColor = outCol(col, a * vColor.a);
    return;
  }
  if (k == 4) {
    vec2 uv = mix(vExtra.xy, vExtra.zw, p / vSize * 0.5 + 0.5);
    float a = texture2D(uAtlas, uv).a;
    if (a <= 0.01) discard;
    gl_FragColor = outCol(vColor.rgb, a * vColor.a);
    return;
  }
  if (k == 5) {
    // rounded rect: half size vExtra.xy, corner radius vExtra.z, border width vExtra.w (0 = filled)
    vec2 hs = vExtra.xy;
    float cr = vExtra.z;
    vec2 q = abs(p) - hs + cr;
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - cr;
    float aa = fwidth(dist);
    float a;
    a = 1.0 - smoothstep(-aa, aa, dist);
    if (vExtra.w > 0.0) a *= smoothstep(-vExtra.w - aa, -vExtra.w + aa, dist);
    float halo = vExtra2.x > 0.0 ? exp(-max(dist, 0.0) / max(0.02, vExtra2.x) * 2.5) * step(0.0, dist) : 0.0;
    a = max(a, halo * 0.5);
    if (a <= 0.002) discard;
    gl_FragColor = outCol(vColor.rgb, a * vColor.a);
    return;
  }
  if (k == 6) {
    // flat disc with soft inner gradient; vExtra.x = ring width (0 = filled)
    float r = vSize.x;
    float l = length(p);
    float aa = fwidth(l);
    float a = 1.0 - smoothstep(r - aa, r, l);
    if (vExtra.x > 0.0) a *= smoothstep(r - vExtra.x - aa, r - vExtra.x, l);
    if (a <= 0.002) discard;
    vec3 col = vColor.rgb * (0.85 + 0.3 * (1.0 - l / r));
    gl_FragColor = outCol(col, a * vColor.a);
    return;
  }
  // spark: bright core with a four-point glint
  float d = length(p) / vSize.x;
  float core = exp(-d * d * 18.0);
  float cross = exp(-abs(p.x) / vSize.x * 22.0) + exp(-abs(p.y) / vSize.x * 22.0);
  float a = clamp(core + cross * 0.35 * (1.0 - d), 0.0, 1.0) * (1.0 - smoothstep(0.7, 1.0, d));
  gl_FragColor = outCol(vColor.rgb + core * 0.4, a * vColor.a);
}
`;

export class ShapeBatch {
  readonly mesh: THREE.Mesh;
  private data: Float32Array;
  private buffer: THREE.InstancedInterleavedBuffer;
  private geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  count = 0;
  capacity: number;
  private readonly maxCapacity: number;

  constructor(additive: boolean, atlas: THREE.Texture, capacity = 2048, maxCapacity = 65536) {
    this.capacity = capacity;
    this.maxCapacity = maxCapacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.geometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(2, 2);
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.bindAttributes();
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uAtlas: { value: atlas }, uAdditive: { value: additive ? 1 : 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  private bindAttributes(): void {
    const g = this.geometry;
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.buffer, 2, 0));
    g.setAttribute('iSize', new THREE.InterleavedBufferAttribute(this.buffer, 2, 2));
    g.setAttribute('iMisc', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    g.setAttribute('iColor', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8));
    g.setAttribute('iExtra', new THREE.InterleavedBufferAttribute(this.buffer, 4, 12));
  }

  private grow(): boolean {
    if (this.capacity >= this.maxCapacity) return false;
    const cap = Math.min(this.maxCapacity, this.capacity * 2);
    const next = new Float32Array(cap * STRIDE);
    next.set(this.data);
    this.data = next;
    this.capacity = cap;
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.bindAttributes();
    return true;
  }

  begin(): void {
    this.count = 0;
  }

  /** Writes one instance; returns false if the hard cap is reached. */
  push(x: number, y: number, sx: number, sy: number, rot: number, kind: number, r: number, g: number, b: number, a: number, e0 = 0, e1 = 0, e2 = 0, e3 = 0, f0 = 0, f1 = 0): boolean {
    if (this.count >= this.capacity && !this.grow()) return false;
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = sx;
    d[o + 3] = sy;
    d[o + 4] = rot;
    d[o + 5] = kind;
    d[o + 6] = f0;
    d[o + 7] = f1;
    d[o + 8] = r;
    d[o + 9] = g;
    d[o + 10] = b;
    d[o + 11] = a;
    d[o + 12] = e0;
    d[o + 13] = e1;
    d[o + 14] = e2;
    d[o + 15] = e3;
    this.count++;
    return true;
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    this.buffer.clearUpdateRanges();
    if (this.count > 0) {
      this.buffer.addUpdateRange(0, this.count * STRIDE);
      this.buffer.needsUpdate = true;
    }
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
