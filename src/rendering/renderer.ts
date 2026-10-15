// Three.js setup: orthographic camera, background shader, and the four shape batches.
// The canvas backing store is sized independently of its CSS box so previews can
// be cheap (capped DPR) while exports render at exact pixel dimensions.
import * as THREE from 'three';
import { ShapeBatch } from './batch.ts';
import { DrawList, GlyphAtlas, type Layer } from './draw.ts';
import type { CameraController } from './camera.ts';
import type { Palette } from './palette.ts';

const bgVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const bgFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec4 uCam;      // x, y, height, aspect
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGrid;
uniform float uGridAmt;
uniform float uTime;
uniform float uPulse;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gridLine(vec2 w, float spacing, float width) {
  vec2 g = abs(fract(w / spacing - 0.5) - 0.5) * spacing;
  vec2 fw = fwidth(w);
  vec2 l = 1.0 - smoothstep(vec2(0.0), fw * 1.5 + width, g);
  return max(l.x, l.y);
}
void main() {
  vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
  // world position with mild parallax for depth
  vec2 ndc = vUv - 0.5;
  vec2 world = uCam.xy * 0.6 + ndc * vec2(uCam.z * uCam.w, uCam.z) * 0.85;
  float g1 = gridLine(world, 1.0, 0.0) * 0.35;
  float g2 = gridLine(world, 5.0, 0.01) * 0.8;
  col += uGrid * (g1 + g2) * uGridAmt * 0.22;
  // far starfield
  vec2 sp = uCam.xy * 0.25 + ndc * vec2(uCam.z * uCam.w, uCam.z) * 0.6;
  vec2 cell = floor(sp * 3.0);
  vec2 f = fract(sp * 3.0) - 0.5;
  float h = hash(cell);
  vec2 off = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
  float star = step(0.93, h) * exp(-dot(f - off * 0.6, f - off * 0.6) * 900.0) * (0.5 + 0.5 * sin(uTime * (1.0 + h * 3.0) + h * 40.0));
  col += vec3(star) * 0.5 * uGridAmt;
  // soft centre bloom and vignette
  float r = length(ndc * vec2(uCam.w, 1.0));
  col += uGrid * 0.08 * (1.0 - smoothstep(0.0, 0.9, r)) * (1.0 + uPulse * 2.0);
  col *= 1.0 - smoothstep(0.55, 1.25, r) * 0.55;
  // dither to avoid banding in recordings
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly scene = new THREE.Scene();
  readonly hudScene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  readonly hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  readonly draw: DrawList;
  private batches: Record<Layer, ShapeBatch>;
  private bg: THREE.Mesh;
  private bgMat: THREE.ShaderMaterial;
  readonly atlas: GlyphAtlas;
  pixelWidth = 1;
  pixelHeight = 1;
  pulse = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.setClearColor(0x000000, 1);
    this.gl.autoClear = false;
    this.atlas = new GlyphAtlas();
    this.batches = {
      trail: new ShapeBatch(true, this.atlas.texture),
      main: new ShapeBatch(false, this.atlas.texture),
      glow: new ShapeBatch(true, this.atlas.texture),
      hud: new ShapeBatch(false, this.atlas.texture, 1024),
    };
    this.draw = new DrawList(this.batches, this.atlas);
    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: bgVert,
      fragmentShader: bgFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCam: { value: new THREE.Vector4(0, 0, 20, 1) },
        uTop: { value: new THREE.Color() },
        uBottom: { value: new THREE.Color() },
        uGrid: { value: new THREE.Color() },
        uGridAmt: { value: 1 },
        uTime: { value: 0 },
        uPulse: { value: 0 },
      },
    });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    this.bg.frustumCulled = false;
    this.bg.renderOrder = -10;
    this.scene.add(this.bg);
    let order = 0;
    for (const k of ['trail', 'main', 'glow'] as Layer[]) {
      this.batches[k].mesh.renderOrder = order++;
      this.scene.add(this.batches[k].mesh);
    }
    this.hudScene.add(this.batches.hud.mesh);
  }

  /** Size the drawing buffer in device pixels; CSS size is managed by the layout. */
  setPixelSize(w: number, h: number): void {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (w === this.pixelWidth && h === this.pixelHeight) return;
    this.pixelWidth = w;
    this.pixelHeight = h;
    this.gl.setPixelRatio(1);
    this.gl.setSize(w, h, false);
  }

  get aspect(): number {
    return this.pixelWidth / this.pixelHeight;
  }

  applyPalette(p: Palette, gridAmount: number): void {
    const u = this.bgMat.uniforms;
    (u.uTop.value as THREE.Color).setRGB(p.bgTop[0], p.bgTop[1], p.bgTop[2]);
    (u.uBottom.value as THREE.Color).setRGB(p.bgBottom[0], p.bgBottom[1], p.bgBottom[2]);
    (u.uGrid.value as THREE.Color).setRGB(p.grid[0], p.grid[1], p.grid[2]);
    u.uGridAmt.value = gridAmount;
  }

  render(cam: CameraController, time: number): void {
    const w = cam.height * this.aspect;
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = cam.height / 2;
    this.camera.bottom = -cam.height / 2;
    this.camera.position.set(cam.x, cam.y, 5);
    this.camera.updateProjectionMatrix();
    this.hudCamera.left = -this.aspect;
    this.hudCamera.right = this.aspect;
    this.hudCamera.top = 1;
    this.hudCamera.bottom = -1;
    this.hudCamera.position.set(0, 0, 5);
    this.hudCamera.updateProjectionMatrix();
    const u = this.bgMat.uniforms;
    (u.uCam.value as THREE.Vector4).set(cam.x, cam.y, cam.height, this.aspect);
    u.uTime.value = time;
    u.uPulse.value = this.pulse;
    this.gl.clear();
    this.gl.render(this.scene, this.camera);
    this.gl.render(this.hudScene, this.hudCamera);
  }

  dispose(): void {
    for (const b of Object.values(this.batches)) b.dispose();
    this.bgMat.dispose();
    this.bg.geometry.dispose();
    this.atlas.texture.dispose();
    this.gl.dispose();
  }
}
