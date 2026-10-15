import type { Scene } from '../scenes/types.ts';
import { BuilderScene } from '../scenes/builder/builderScene.ts';
import { GrowingBallScene } from '../scenes/generative/growingBall.ts';
import { CascadeScene } from '../scenes/generative/cascade.ts';
import { SequencerScene } from '../scenes/generative/sequencer.ts';
import { ShepardLabScene } from '../scenes/generative/shepardLab.ts';
import { PerformanceScene } from '../scenes/performance/perfScene.ts';
import { rainFamily } from '../scenes/performance/rain.ts';

export interface SceneEntry {
  id: string;
  title: string;
  mode: 'playground' | 'performance';
  make: () => Scene;
}

export const SCENES: SceneEntry[] = [
  { id: 'builder', title: 'Builder Sandbox', mode: 'playground', make: () => new BuilderScene() },
  { id: 'growing', title: 'Growing Ball', mode: 'playground', make: () => new GrowingBallScene() },
  { id: 'cascade', title: 'Collision Cascade', mode: 'playground', make: () => new CascadeScene() },
  { id: 'sequencer', title: 'Geometric Sequencer', mode: 'playground', make: () => new SequencerScene() },
  { id: 'shepard', title: 'Shepard-Tone Lab', mode: 'playground', make: () => new ShepardLabScene() },
  { id: 'rain', title: 'Melody Rain', mode: 'performance', make: () => new PerformanceScene(rainFamily) },
];

export function sceneEntry(id: string): SceneEntry | undefined {
  return SCENES.find((s) => s.id === id);
}
