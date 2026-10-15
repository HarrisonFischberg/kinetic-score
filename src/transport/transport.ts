// The single performance clock. Position (seconds) is derived from a clock
// function — the AudioContext clock once audio runs, performance.now() before —
// plus an anchor that is re-set on every play/pause/seek, so pausing never
// accumulates drift and visuals, audio and recording all read the same value.

export type Clock = () => number;
export type TransportState = 'stopped' | 'playing' | 'paused';

export class Transport {
  private clock: Clock;
  private anchorClock = 0;
  private anchorPos = 0;
  private _state: TransportState = 'stopped';
  private _rate = 1;
  /** incremented on every discontinuity (seek/stop/rate) so consumers can resync */
  epoch = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  get state(): TransportState {
    return this._state;
  }

  get playing(): boolean {
    return this._state === 'playing';
  }

  get rate(): number {
    return this._rate;
  }

  now(): number {
    return this.clock();
  }

  /** Switch clock source (e.g. when the AudioContext starts) without a position jump. */
  setClock(clock: Clock): void {
    const pos = this.position;
    this.clock = clock;
    this.anchorClock = clock();
    this.anchorPos = pos;
  }

  get position(): number {
    if (this._state !== 'playing') return this.anchorPos;
    return this.anchorPos + (this.clock() - this.anchorClock) * this._rate;
  }

  play(): void {
    if (this._state === 'playing') return;
    this.anchorClock = this.clock();
    this._state = 'playing';
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this.anchorPos = this.position;
    this._state = 'paused';
  }

  stop(): void {
    this.anchorPos = 0;
    this._state = 'stopped';
    this.epoch++;
  }

  seek(pos: number): void {
    this.anchorPos = Math.max(0, pos);
    this.anchorClock = this.clock();
    this.epoch++;
  }

  setRate(r: number): void {
    const pos = this.position;
    this._rate = Math.max(0.05, Math.min(4, r));
    this.anchorPos = pos;
    this.anchorClock = this.clock();
    this.epoch++;
  }

  /** Clock time at which `pos` is (or would be) reached while playing. */
  clockAt(pos: number): number {
    const base = this._state === 'playing' ? this.anchorClock : this.clock();
    return base + (pos - this.anchorPos) / this._rate;
  }
}

export interface Scheduled {
  time: number;
}

export interface Cancellable {
  cancel(): void;
}

interface Pending {
  index: number;
  when: number;
  handles: Cancellable[];
}

/**
 * Lookahead scheduler: each tick, events whose time falls inside
 * [position, position + lookahead) are handed to the sink with an exact clock
 * time. Pausing or seeking cancels everything not yet started and rewinds the
 * cursor to the first cancelled event, so resuming never duplicates or reorders.
 */
export class EventScheduler<E extends Scheduled> {
  private events: E[];
  private cursor = 0;
  private pending: Pending[] = [];
  private readonly sink: (e: E, when: number) => Cancellable[];
  lookahead: number;
  scheduledCount = 0;

  constructor(events: E[], sink: (e: E, when: number) => Cancellable[], lookahead = 0.15) {
    this.events = [...events].sort((a, b) => a.time - b.time);
    this.sink = sink;
    this.lookahead = lookahead;
  }

  get index(): number {
    return this.cursor;
  }

  get length(): number {
    return this.events.length;
  }

  setEvents(events: E[]): void {
    this.cancelAll();
    this.events = [...events].sort((a, b) => a.time - b.time);
    this.cursor = 0;
  }

  tick(t: Transport): void {
    if (!t.playing) return;
    const now = t.now();
    const pos = t.position;
    const horizon = pos + this.lookahead;
    while (this.cursor < this.events.length && this.events[this.cursor].time < horizon) {
      const e = this.events[this.cursor];
      if (e.time >= pos - 0.03) {
        const when = Math.max(now, t.clockAt(e.time));
        const handles = this.sink(e, when);
        this.pending.push({ index: this.cursor, when, handles });
        this.scheduledCount++;
      }
      this.cursor++;
    }
    // forget events that have started long ago
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop].when < now - 2) drop++;
    if (drop) this.pending.splice(0, drop);
  }

  /** Cancel not-yet-started events and rewind to the first of them. */
  pause(now: number): void {
    let first = -1;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.when > now + 0.002) {
        for (const h of p.handles) h.cancel();
        first = p.index;
        this.pending.splice(i, 1);
      }
    }
    if (first >= 0) this.cursor = Math.min(this.cursor, first);
  }

  /** Jump: cancel all future events and continue from `pos`. */
  seek(pos: number, now: number): void {
    this.pause(now);
    this.cursor = this.firstAtOrAfter(pos);
  }

  cancelAll(): void {
    for (const p of this.pending) for (const h of p.handles) h.cancel();
    this.pending.length = 0;
  }

  reset(): void {
    this.cancelAll();
    this.cursor = 0;
  }

  private firstAtOrAfter(pos: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
