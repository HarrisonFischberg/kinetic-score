// Real-time canvas + Web Audio capture via MediaRecorder. The video track comes
// from the WebGL canvas (everything visible is rendered into it), the audio track
// from a MediaStreamDestination on the master bus. Never the DOM, mic or camera.

export interface MimeChoice {
  mime: string;
  ext: 'mp4' | 'webm';
  label: string;
}

const CANDIDATES: MimeChoice[] = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264 + AAC)' },
  { mime: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4', label: 'MP4 (H.264 + AAC)' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9 + Opus)' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8 + Opus)' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM' },
  { mime: 'video/mp4', ext: 'mp4', label: 'MP4' },
];

export function recordingSupport(): { ok: boolean; reason?: string; choice?: MimeChoice } {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return { ok: false, reason: 'This browser has no MediaRecorder, so video export is unavailable. Screenshots still work.' };
  const c = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: unknown };
  if (typeof c.captureStream !== 'function') return { ok: false, reason: 'This browser cannot capture a canvas stream, so video export is unavailable. Screenshots still work.' };
  const choice = CANDIDATES.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m.mime);
    } catch {
      return false;
    }
  });
  if (!choice) return { ok: false, reason: 'No supported video format (MP4 or WebM) was found for recording.' };
  return { ok: true, choice };
}

/** container extension that matches a MIME type (as actually reported by the recorder) */
export function extensionFor(mime: string): 'mp4' | 'webm' {
  return mime.toLowerCase().startsWith('video/mp4') ? 'mp4' : 'webm';
}

export interface RecordingResult {
  url: string;
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
  filename: string;
  width: number;
  height: number;
  seconds: number;
  hasAudio: boolean;
}

export class Recorder {
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private videoTrack: MediaStreamTrack | null = null;
  private startedAt = 0;
  private meta = { width: 0, height: 0, base: 'kinetic-score', hasAudio: false };
  last: RecordingResult | null = null;
  onDone: (r: RecordingResult) => void = () => {};
  onError: (msg: string) => void = () => {};

  get recording(): boolean {
    return !!this.mr && this.mr.state === 'recording';
  }

  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream | null, fps: number, width: number, height: number, baseName: string): string | null {
    const sup = recordingSupport();
    if (!sup.ok || !sup.choice) return sup.reason ?? 'Recording is unsupported.';
    if (this.recording) return 'Already recording.';
    const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    const tracks: MediaStreamTrack[] = [...stream.getVideoTracks()];
    const audioTracks = audio?.getAudioTracks() ?? [];
    tracks.push(...audioTracks);
    const combined = new MediaStream(tracks);
    let mr: MediaRecorder;
    try {
      const bps = Math.round(width * height * fps * 0.18);
      mr = new MediaRecorder(combined, { mimeType: sup.choice.mime, videoBitsPerSecond: Math.min(24_000_000, Math.max(4_000_000, bps)), audioBitsPerSecond: 192_000 });
    } catch (e) {
      this.videoTrack?.stop();
      return `Could not start the recorder: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.chunks = [];
    this.meta = { width, height, base: baseName, hasAudio: audioTracks.length > 0 };
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    mr.onerror = () => this.onError('The recorder reported an error; the take was discarded.');
    mr.onstop = () => this.finish(mr);
    mr.start(500);
    this.mr = mr;
    this.startedAt = performance.now();
    return null;
  }

  stop(): void {
    if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
  }

  private finish(mr: MediaRecorder): void {
    const seconds = (performance.now() - this.startedAt) / 1000;
    // stop only our canvas track; the audio track belongs to the live audio graph
    this.videoTrack?.stop();
    this.videoTrack = null;
    this.mr = null;
    const mime = (mr.mimeType || this.chunks[0]?.type || 'video/webm').split(';')[0];
    const ext = extensionFor(mime);
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];
    if (blob.size === 0) {
      this.onError('The recording came out empty. Try again, or try another browser.');
      return;
    }
    // keep the previous result's URL alive until the new one is ready, then release it
    const prev = this.last;
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    this.last = { url, blob, mime, ext, filename: `${this.meta.base}_${this.meta.width}x${this.meta.height}_${stamp}.${ext}`, width: this.meta.width, height: this.meta.height, seconds, hasAudio: this.meta.hasAudio };
    if (prev) setTimeout(() => URL.revokeObjectURL(prev.url), 60_000);
    this.onDone(this.last);
  }

  dispose(): void {
    this.stop();
    if (this.last) URL.revokeObjectURL(this.last.url);
    this.last = null;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
