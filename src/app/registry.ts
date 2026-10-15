import type { Scene } from '../scenes/types.ts';
import { BuilderScene } from '../scenes/builder/builderScene.ts';

export interface SceneEntry {
  id: string;
  title: string;
  mode: 'playground' | 'performance';
  make: () => Scene;
}

export const SCENES: SceneEntry[] = [
  { id: 'builder', title: 'Builder Sandbox', mode: 'playground', make: () => new BuilderScene() },
];

export function sceneEntry(id: string): SceneEntry | undefined {
  return SCENES.find((s) => s.id === id);
}
