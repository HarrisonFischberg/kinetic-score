import { FIXED_DT } from './physics.ts';

/**
 * Fixed-timestep accumulator with a catch-up cap: a long frame (background tab,
 * GC pause) never produces a burst of hundreds of steps — excess time is dropped.
 */
export class Stepper {
  accumulator = 0;
  readonly dt: number;
  readonly maxSteps: number;
  droppedTime = 0;

  constructor(dt = FIXED_DT, maxSteps = 10) {
    this.dt = dt;
    this.maxSteps = maxSteps;
  }

  /** Returns how many fixed steps to run for this frame's elapsed time. */
  advance(elapsed: number): number {
    if (!(elapsed > 0)) return 0;
    this.accumulator += elapsed;
    let n = Math.floor(this.accumulator / this.dt);
    if (n > this.maxSteps) {
      this.droppedTime += (n - this.maxSteps) * this.dt;
      n = this.maxSteps;
      this.accumulator = 0;
    } else this.accumulator -= n * this.dt;
    return n;
  }

  /** interpolation factor for rendering between the last two states */
  get alpha(): number {
    return this.accumulator / this.dt;
  }

  reset(): void {
    this.accumulator = 0;
    this.droppedTime = 0;
  }
}
