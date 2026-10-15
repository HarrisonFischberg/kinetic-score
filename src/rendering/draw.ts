// Immediate-mode drawing API used by every scene. Calls are written straight into
// the instanced batches; layers: trail (additive, under), main (alpha), glow
// (additive, over) and hud (alpha, screen space in [-1,1] × aspect units).
import * as THREE from 'three';
import { KIND, ShapeBatch } from './batch.ts';

export type Layer = 'trail' | 'main' | 'glow' | 'hud';
export type RGB = readonly [number, number, number];

interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  adv: number;
}

const CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  '♯♭♮•·→←↑↓×–—…éèêüöäßÜÖÄñçàâôîùû′″“”‘’°±▶❚■●○♪♫';

export class GlyphAtlas {
  readonly texture: THREE.Texture;
  private glyphs = new Map<string, Glyph>();
  /** cell height / em size, and cell width / em */
  readonly cellW: number;
  readonly cellH: number;
  readonly em: number;

  constructor() {
    const em = 56;
    const cellW = 64;
    const cellH = 72;
    const cols = 32;
    const rows = Math.ceil(CHARS.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW;
    canvas.height = THREE.MathUtils.ceilPowerOfTwo(rows * cellH);
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.textBaseline = 'alphabetic';
    g.font = `600 ${em * 0.78}px "Inter", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif`;
    const chars = Array.from(CHARS);
    chars.forEach((ch, i) => {
      const cx = (i % cols) * cellW;
      const cy = Math.floor(i / cols) * cellH;
      g.fillText(ch, cx + 4, cy + cellH * 0.74);
      const w = g.measureText(ch).width;
      this.glyphs.set(ch, {
        u0: cx / canvas.width,
        u1: (cx + cellW) / canvas.width,
        // texture is flipped (flipY default true): v = 1 - y
        v0: 1 - (cy + cellH) / canvas.height,
        v1: 1 - cy / canvas.height,
        adv: (w + 1) / em,
      });
    });
    this.em = em;
    this.cellW = cellW / em;
    this.cellH = cellH / em;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
  }

  get(ch: string): Glyph | undefined {
    return this.glyphs.get(ch) ?? this.glyphs.get('?');
  }

  width(text: string, size: number): number {
    let w = 0;
    for (const ch of text) w += (this.get(ch)?.adv ?? 0.5) * size;
    return w;
  }
}

export class DrawList {
  glowScale = 1;
  /** multiplies line/arc halos (appearance setting) */
  haloScale = 1;
  private readonly b: Record<Layer, ShapeBatch>;
  readonly atlas: GlyphAtlas;

  constructor(batches: Record<Layer, ShapeBatch>, atlas: GlyphAtlas) {
    this.b = batches;
    this.atlas = atlas;
  }

  begin(): void {
    for (const k of Object.keys(this.b) as Layer[]) this.b[k].begin();
  }

  end(): void {
    for (const k of Object.keys(this.b) as Layer[]) this.b[k].end();
  }

  get instanceCount(): number {
    let n = 0;
    for (const k of Object.keys(this.b) as Layer[]) n += this.b[k].count;
    return n;
  }

  ball(x: number, y: number, r: number, c: RGB, alpha = 1, spin = 0, flash = 0): void {
    if (this.glowScale > 0) this.b.glow.push(x, y, r * 2.6, r * 2.6, 0, KIND.glow, c[0], c[1], c[2], (0.16 + flash * 0.35) * this.glowScale * alpha);
    this.b.main.push(x, y, r, r, 0, KIND.ball, c[0], c[1], c[2], alpha, spin, flash);
  }

  glow(x: number, y: number, r: number, c: RGB, intensity: number, layer: Layer = 'glow'): void {
    const a = intensity * (layer === 'glow' ? this.glowScale : 1);
    if (a <= 0.002) return;
    this.b[layer].push(x, y, r, r, 0, KIND.glow, c[0], c[1], c[2], a);
  }

  line(ax: number, ay: number, bx: number, by: number, thick: number, c: RGB, alpha = 1, halo = 0, layer: Layer = 'main', inner = 1): void {
    const dx = bx - ax;
    const dy = by - ay;
    const hl = Math.sqrt(dx * dx + dy * dy) * 0.5;
    const h = halo * this.haloScale;
    const pad = h > 0 ? h * 3 : thick * 0.6 + 0.01;
    this.b[layer].push((ax + bx) * 0.5, (ay + by) * 0.5, hl + thick + pad, thick + pad, Math.atan2(dy, dx), KIND.capsule, c[0], c[1], c[2], alpha, hl, thick, h, inner);
  }

  arc(cx: number, cy: number, radius: number, thick: number, start: number, sweep: number, c: RGB, alpha = 1, halo = 0, layer: Layer = 'main', inner = 1): void {
    const h = halo * this.haloScale;
    const s = radius + thick + (h > 0 ? h * 3 : thick * 0.6 + 0.01);
    this.b[layer].push(cx, cy, s, s, 0, KIND.arc, c[0], c[1], c[2], alpha, radius, thick, start, Math.max(0, Math.min(Math.PI * 2, sweep)), h, inner);
  }

  ring(cx: number, cy: number, radius: number, thick: number, c: RGB, alpha = 1, halo = 0, layer: Layer = 'main'): void {
    this.arc(cx, cy, radius, thick, 0, Math.PI * 2, c, alpha, halo, layer);
  }

  rect(cx: number, cy: number, hw: number, hh: number, rot: number, c: RGB, alpha = 1, corner = 0, border = 0, halo = 0, layer: Layer = 'main'): void {
    const h = halo * this.haloScale;
    const pad = h > 0 ? h * 3 : 0.02 + Math.min(hw, hh) * 0.05;
    this.b[layer].push(cx, cy, hw + pad, hh + pad, rot, KIND.rect, c[0], c[1], c[2], alpha, hw, hh, Math.min(corner, hw, hh), border, h, 0);
  }

  disc(x: number, y: number, r: number, c: RGB, alpha = 1, ringWidth = 0, layer: Layer = 'main'): void {
    this.b[layer].push(x, y, r, r, 0, KIND.disc, c[0], c[1], c[2], alpha, ringWidth);
  }

  spark(x: number, y: number, size: number, c: RGB, alpha = 1): void {
    this.b.glow.push(x, y, size, size, 0, KIND.spark, c[0], c[1], c[2], alpha * Math.max(0.4, this.glowScale));
  }

  text(str: string, x: number, y: number, size: number, c: RGB, alpha = 1, align: 'left' | 'center' | 'right' = 'left', layer: Layer = 'main'): void {
    const at = this.atlas;
    let cx = x;
    if (align !== 'left') {
      const w = at.width(str, size);
      cx -= align === 'center' ? w / 2 : w;
    }
    const hw = (at.cellW * size) / 2;
    const hh = (at.cellH * size) / 2;
    // baseline sits at ~0.74 of the cell from the top; centre text vertically on y
    const oy = y + hh - at.cellH * size * 0.74 + size * 0.28;
    for (const ch of str) {
      const g = at.get(ch);
      if (!g) continue;
      if (ch !== ' ') this.b[layer].push(cx + hw - (4 / at.em) * size, oy, hw, hh, 0, KIND.glyph, c[0], c[1], c[2], alpha, g.u0, g.v0, g.u1, g.v1);
      cx += g.adv * size;
    }
  }

  textWidth(str: string, size: number): number {
    return this.atlas.width(str, size);
  }
}
