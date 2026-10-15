import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScoreData } from '../src/music/score.ts';
import { registerScore } from '../src/music/library.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadScores(): ScoreData[] {
  const dir = join(root, 'public', 'scores');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScoreData);
}

/** register all bundled scores in the in-memory library (what the app does after fetching) */
export function registerAll(): ScoreData[] {
  const all = loadScores();
  for (const s of all) registerScore(s);
  return all;
}

export function rawScore(id: string): unknown {
  return JSON.parse(readFileSync(join(root, 'public', 'scores', `${id}.json`), 'utf8'));
}
