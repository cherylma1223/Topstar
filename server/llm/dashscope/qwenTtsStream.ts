/**
 * Qwen-Audio-TTS 流式合成
 *
 * 用非实时 HTTP 接口 + `X-DashScope-SSE: enable`，服务端把音频按块吐出来，
 * 业务层可以直接转给浏览器（SSE）边收边播，首声不用等整段合成完。
 *
 * 事件格式（实测）：
 *   id:1
 *   event:result
 *   :HTTP_STATUS/200
 *   data:{"output":{"audio":{"data":"<base64 pcm>"},...}}
 * 其中 data 为空的块（sentence-begin / sentence-end）直接跳过。
 */
import { LLMError, errorMessage } from '../errors';
import { classifyDashscopeError } from './QwenTtsProvider';
import { dashscopeApiKey, dashscopeEndpoint, resolveQwenVoice } from './QwenTtsProvider';

export interface QwenStreamOptions {
  text: string;
  voice?: string;
  model: string;
  signal?: AbortSignal;
}

/** 从一段 SSE 事件里取出音频块；没有音频就返回 null */
function extractAudio(block: string): Buffer | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim());
  if (dataLines.length === 0) return null;

  try {
    const payload = JSON.parse(dataLines.join('\n'));
    const b64 = payload?.output?.audio?.data;
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    return Buffer.from(b64, 'base64');
  } catch {
    return null; // 半截 JSON 或非音频事件，忽略
  }
}

export async function* qwenTtsAudioChunks(opts: QwenStreamOptions): AsyncGenerator<Buffer, void, void> {
  const apiKey = dashscopeApiKey();
  if (!apiKey) {
    throw new LLMError('NOT_CONFIGURED', 'DASHSCOPE_API_KEY is not set', { provider: 'dashscope', model: opts.model });
  }

  const voice = resolveQwenVoice(opts.voice);
  const timeoutMs = Number(process.env.DASHSCOPE_TTS_TIMEOUT_MS) || 60_000;
  console.log(`[LLM dashscope tts:stream] model=${opts.model} voice=${voice} chars=${opts.text.length}`);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(dashscopeEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify({
          model: opts.model,
          input: {
            text: opts.text,
            voice,
            format: 'pcm',
            sample_rate: 24000,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `stream request failed: ${errorMessage(err)}`, {
        provider: 'dashscope', model: opts.model, cause: err,
      });
    }

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      throw new LLMError(classifyDashscopeError(res.status, raw), `HTTP ${res.status}: ${raw.slice(0, 300)}`, {
        provider: 'dashscope', model: opts.model,
      });
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
        const audio = extractAudio(block);
        if (audio) yield audio;
        sep = buffer.indexOf('\n\n');
      }
    }

    const tail = extractAudio(buffer);
    if (tail) yield tail;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
