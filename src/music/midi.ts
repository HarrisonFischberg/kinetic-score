// Minimal Standard MIDI File (SMF type 0/1) reader.
// Used offline by scripts/build-scores.ts to turn the Mutopia source files into
// inspectable JSON, and in the browser by the optional MIDI import. Pure data
// parsing only: nothing in a file is ever executed.

export interface MidiNote {
  tick: number;
  durTicks: number;
  pitch: number;
  velocity: number;
  channel: number;
}

export interface MidiTrack {
  name: string;
  program: number | null;
  notes: MidiNote[];
}

export interface MidiTempo {
  tick: number;
  usPerQuarter: number;
}

export interface MidiTimeSig {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface MidiFile {
  format: number;
  ppq: number;
  tracks: MidiTrack[];
  tempos: MidiTempo[];
  timeSigs: MidiTimeSig[];
}

class Reader {
  pos = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get length(): number {
    return this.bytes.length;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('Unexpected end of MIDI data');
    return this.bytes[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }
  str(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  varLen(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('Invalid variable-length quantity');
  }
  bytesOut(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error('Unexpected end of MIDI data');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

const MAX_NOTES = 200_000;

export function parseMidi(data: Uint8Array): MidiFile {
  const r = new Reader(data);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header)');
  const headerLen = r.u32();
  const format = r.u16();
  const nTracks = r.u16();
  const division = r.u16();
  r.pos += headerLen - 6;
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  if (format > 1) throw new Error(`MIDI format ${format} is not supported`);
  const ppq = division;

  const tracks: MidiTrack[] = [];
  const tempos: MidiTempo[] = [];
  const timeSigs: MidiTimeSig[] = [];
  let totalNotes = 0;

  for (let t = 0; t < nTracks && r.pos < r.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = r.pos + len;
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const track: MidiTrack = { name: '', program: null, notes: [] };
    const open = new Map<number, { tick: number; velocity: number }[]>();
    let tick = 0;
    let status = 0;
    while (r.pos < end) {
      tick += r.varLen();
      let b = r.u8();
      if (b < 0x80) {
        // running status
        if (!status) throw new Error('Running status without previous status');
        r.pos--;
        b = status;
      } else if (b < 0xf0) {
        status = b;
      }
      if (b === 0xff) {
        const type = r.u8();
        const l = r.varLen();
        const payload = r.bytesOut(l);
        if (type === 0x03 && !track.name) track.name = String.fromCharCode(...payload).trim();
        else if (type === 0x51 && l === 3) {
          tempos.push({ tick, usPerQuarter: (payload[0] << 16) | (payload[1] << 8) | payload[2] });
        } else if (type === 0x58 && l >= 2) {
          timeSigs.push({ tick, numerator: payload[0], denominator: 2 ** payload[1] });
        } else if (type === 0x2f) {
          break;
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.bytesOut(r.varLen());
        continue;
      }
      const kind = b & 0xf0;
      const channel = b & 0x0f;
      const d1 = r.u8();
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();
      const key = channel * 128 + d1;
      if (kind === 0x90 && d2 > 0) {
        const stack = open.get(key) ?? [];
        stack.push({ tick, velocity: d2 });
        open.set(key, stack);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const stack = open.get(key);
        const on = stack?.shift();
        if (on) {
          track.notes.push({ tick: on.tick, durTicks: Math.max(1, tick - on.tick), pitch: d1, velocity: on.velocity, channel });
          if (++totalNotes > MAX_NOTES) throw new Error('MIDI file has too many notes');
        }
      } else if (kind === 0xc0 && track.program === null) {
        track.program = d1;
      }
    }
    r.pos = end;
    track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    tracks.push(track);
  }
  tempos.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);
  return { format, ppq, tracks, tempos, timeSigs };
}
