/**
 * 语音流式播放（支持暂停/续播）
 *
 * 服务端 `/api/v2/tts/stream` 以 SSE 下发 base64 PCM 块（24kHz、16bit、单声道）。
 * 这里把「下载」和「播放」解耦：
 *  - 下载：SSE 一直接收，音频块累积在内存里，暂停也不断流（长文本暂停后再播不用重新合成）
 *  - 播放：按块排队，首包到达就出声；暂停时记住播放位置，续播从该位置继续
 *
 * 用法：
 *   const c = playStreamingSpeech({ ... });
 *   c.pause(); c.resume(); c.stop();
 */
import { authedFetch } from './auth';

export interface StreamingSpeechOptions {
  contentType: 'text' | 'report';
  text?: string;
  report?: unknown;
  voice?: string;
  isFieldGuidance?: boolean;
  ctx: AudioContext;
  /** 第一块音频开始播放 */
  onStart?: () => void;
  /** 全部播放完毕、被停止，或被暂停后不再继续 */
  onEnd?: () => void;
  /** 出错（上层可选择回退到整段合成） */
  onError?: (err: unknown) => void;
}

export interface StreamingSpeechHandle {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** 当前是否处于暂停状态 */
  isPaused: () => boolean;
}

const SAMPLE_RATE = 24000;
/** 相邻音频块的衔接提前量，太小会卡顿、太大增加首声延迟 */
const SCHEDULE_AHEAD_SEC = 0.06;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function playStreamingSpeech(opts: StreamingSpeechOptions): StreamingSpeechHandle {
  const controller = new AbortController();

  /** 已收到的全部 PCM（按块存，避免每块都整体复制） */
  const chunks: Int16Array[] = [];
  let totalSamples = 0;

  const sources = new Set<AudioBufferSourceNode>();
  let nextStartAt = 0;       // 下一块最早可以排队的时间（ctx 时钟）
  let playingSince = 0;      // 当前这轮播放的起点（ctx 时钟）
  let baseOffsetSec = 0;     // playingSince 对应的音频内偏移
  let pausedAtSec = 0;
  let paused = false;
  let streamFinished = false;
  let stopped = false;
  let startedOnce = false;

  const emitEnd = () => {
    if (stopped) return;
    stopped = true;
    opts.onEnd?.();
  };

  const maybeEnd = () => {
    if (streamFinished && !paused && sources.size === 0) emitEnd();
  };

  const positionSec = (): number => {
    if (paused) return pausedAtSec;
    if (!playingSince) return baseOffsetSec;
    return baseOffsetSec + Math.max(0, opts.ctx.currentTime - playingSince);
  };

  const appendChunk = (int16: Int16Array) => {
    if (int16.length === 0) return;
    chunks.push(int16);
    totalSamples += int16.length;
  };

  /** 取音频内 [fromSec, end) 的样本 */
  const sliceFrom = (fromSec: number): Int16Array => {
    const skip = Math.max(0, Math.min(totalSamples, Math.floor(fromSec * SAMPLE_RATE)));
    const out = new Int16Array(totalSamples - skip);
    let cursor = 0;
    let written = 0;
    for (const chunk of chunks) {
      const chunkEnd = cursor + chunk.length;
      if (chunkEnd <= skip) { cursor = chunkEnd; continue; }
      const localStart = Math.max(0, skip - cursor);
      const piece = chunk.subarray(localStart);
      out.set(piece, written);
      written += piece.length;
      cursor = chunkEnd;
    }
    return written === out.length ? out : out.subarray(0, written);
  };

  const scheduleBuffer = (int16: Int16Array): AudioBufferSourceNode | null => {
    if (int16.length === 0) return null;
    const buffer = opts.ctx.createBuffer(1, int16.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768;

    const source = opts.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(opts.ctx.destination);

    const startAt = Math.max(opts.ctx.currentTime + SCHEDULE_AHEAD_SEC, nextStartAt);
    source.start(startAt);
    nextStartAt = startAt + buffer.duration;

    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      maybeEnd();
    };

    if (!startedOnce) {
      startedOnce = true;
      opts.onStart?.();
    }
    return source;
  };

  const scheduleChunk = (int16: Int16Array) => {
    if (paused) return; // 暂停期间只累积，不排队
    if (!playingSince) {
      playingSince = opts.ctx.currentTime + SCHEDULE_AHEAD_SEC;
    }
    scheduleBuffer(int16);
  };

  const startPlaybackFrom = (offsetSec: number) => {
    const remaining = sliceFrom(offsetSec);
    baseOffsetSec = offsetSec;
    playingSince = opts.ctx.currentTime + SCHEDULE_AHEAD_SEC;
    nextStartAt = playingSince;
    paused = false;
    if (remaining.length > 0) scheduleBuffer(remaining);
    // 剩余还没收到时，后续块会接着 scheduled 时间轴排队
  };

  const handleBlock = (block: string) => {
    let event = 'message'; // icon-check-ignore：SSE 事件名，不是图标名
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;

    const raw = dataLines.join('\n');
    if (event === 'audio') {
      try {
        const parsed = JSON.parse(raw);
        const b64 = parsed?.data;
        if (typeof b64 !== 'string' || !b64) return;
        const bytes = base64ToBytes(b64);
        if (bytes.length < 2) return;
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
        appendChunk(int16);
        scheduleChunk(int16);
      } catch { /* 半截数据，忽略 */ }
    } else if (event === 'error') { // icon-check-ignore：SSE 事件名，不是图标名
      let message = '语音合成失败';
      try { message = JSON.parse(raw)?.message || message; } catch { /* keep default */ }
      throw new Error(message);
    }
  };

  const run = async () => {
    try {
      const res = await authedFetch('/api/v2/tts/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: opts.contentType,
          text: opts.text,
          report: opts.report,
          isFieldGuidance: opts.isFieldGuidance,
          voice: opts.voice,
        }),
        signal: controller.signal,
      }, { promptOnUnauthorized: false });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`TTS stream HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleBlock(block);
          sep = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) handleBlock(buffer);

      streamFinished = true;
      maybeEnd();
      if (!startedOnce && !paused) emitEnd();
    } catch (err) {
      if (stopped || (err as any)?.name === 'AbortError') return;
      stopped = true;
      sources.forEach(source => { try { source.stop(); } catch { /* ignore */ } });
      sources.clear();
      opts.onError?.(err);
    }
  };

  void run();

  return {
    pause: () => {
      if (paused || stopped) return;
      pausedAtSec = positionSec();
      paused = true;
      sources.forEach(source => { try { source.stop(); } catch { /* ignore */ } });
      sources.clear();
      playingSince = 0;
      nextStartAt = 0;
    },
    resume: () => {
      if (!paused || stopped) return;
      startPlaybackFrom(pausedAtSec);
    },
    stop: () => {
      controller.abort();
      sources.forEach(source => { try { source.stop(); } catch { /* ignore */ } });
      sources.clear();
      paused = false;
      emitEnd();
    },
    isPaused: () => paused,
  };
}
