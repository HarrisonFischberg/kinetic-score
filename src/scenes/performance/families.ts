import type { Family } from './perfScene.ts';
import { rainFamily } from './rain.ts';
import { canonFamily } from './canon.ts';
import { mazeFamily } from './maze.ts';
import { orbitalFamily } from './orbital.ts';
import { ringsFamily } from './rings.ts';

/** the five classical scene families, in menu order */
export const FAMILIES: Family[] = [canonFamily, rainFamily, mazeFamily, orbitalFamily, ringsFamily];
