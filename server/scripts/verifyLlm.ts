/**
 * LLM 路由自检（切换 provider 时用）
 *
 * 用法：
 *   cd server && npm run verify-llm                  # 只打印每项能力最终解析到的 provider / 模型 / 凭证状态
 *   cd server && npm run verify-llm -- --call intent  # 额外真实调用一次意图识别
 *   cd server && npm run verify-llm -- --call chat    # 额外真实调用一次教练对话
 *
 * 属性：读的是「门面层解析后的结果」，所以能直接回答「我改了 .env 到底生效没有」。
 * 注意：--call 会真实消耗 token（intent 一次不到 1 分钱）。
 */
import 'dotenv/config';
import { getCapabilityConfig, getDeployRegion } from '../llm/config';
import { generate, isCapabilityAvailable } from '../llm';
import { searchWeb, isSearchAvailable, isWebSearchEnabled } from '../search';
import { isLLMError, errorMessage } from '../llm/errors';
import type { Capability } from '../llm/types';

const ALL: Capability[] = ['chat', 'intent', 'video_pass1', 'video_pass15', 'video_pass2', 'tts'];
/** 视频与语音目前只有 gemini 实现；切 provider 时这两类不能跟着走 */
const PINNED: Capability[] = ['video_pass1', 'video_pass15', 'video_pass2', 'tts'];

const CALLABLE: Capability[] = ['chat', 'intent'];

const PROMPTS: Partial<Record<Capability, string>> = {
  intent: '正手攻球的时候手腕要固定吗',
  chat: '用一句话说明乒乓球正手攻球的三个要点',
};

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const callIdx = args.indexOf('--call');
  const callCap = callIdx >= 0 ? args[callIdx + 1] as Capability : undefined;

  const searchIdx = args.indexOf('--search');
  const searchQuery = searchIdx >= 0 ? (args[searchIdx + 1] || '') : undefined;

  if (callIdx >= 0 && !callCap) die('用法：npm run verify-llm -- --call intent|chat');
  if (callCap && !CALLABLE.includes(callCap)) {
    die(`--call 只支持 ${CALLABLE.join(' / ')}（视频与语音请用真实业务链路验证）`);
  }

  console.log(`DEPLOY_REGION = ${getDeployRegion()}`);
  console.log(`WEB_SEARCH   = ${isWebSearchEnabled() ? 'enabled' : 'disabled'} / ${isSearchAvailable() ? '可用' : '不可用'}\n`);

  const rows: string[][] = [];
  for (const cap of ALL) {
    let provider = '-';
    let models = '-';
    try {
      const cfg = getCapabilityConfig(cap);
      provider = cfg.provider;
      models = cfg.models.join(' → ');
    } catch (err) {
      models = `未配置：${errorMessage(err)}`;
    }
    const configured = isCapabilityAvailable(cap) ? 'yes' : 'NO';
    const pinned = PINNED.includes(cap) ? '（固定 gemini）' : '';
    rows.push([cap, provider, models, configured, pinned]);
  }

  const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), ['capability', 'provider', 'models'][i].length));
  const line = (cells: string[]) => `${cells[0].padEnd(widths[0] + 2)}${cells[1].padEnd(widths[1] + 2)}${cells[2].padEnd(widths[2] + 2)}${cells[3] ?? ''} ${cells[4] ?? ''}`;
  console.log(line(['capability', 'provider', 'models', 'key', '']));
  console.log(line(['----------', '--------', '------', '---', '']));
  for (const r of rows) console.log(line(r));

  const missing = rows.filter(r => r[3] === 'NO' && (r[0] === 'chat' || r[0] === 'intent'));
  if (missing.length > 0) {
    console.warn(`\n⚠️  ${missing.map(r => r[0]).join(' / ')} 的 provider 凭证缺失：请求会直接报错（chat）或静默降级（intent）。`);
    console.warn('   检查 .env 里对应的 API key 是否已填。');
  }

  if (searchQuery !== undefined) {
    console.log('\n── 联网检索 ─────────────────────────────────────');
    if (!isSearchAvailable()) {
      console.warn('检索不可用（未配置 key 或 WEB_SEARCH_ENABLED=0）');
    } else {
      const started = Date.now();
      const results = await searchWeb(searchQuery || '乒乓球 正手攻球 要点');
      console.log(`采用 ${results.length} 条，耗时 ${Date.now() - started}ms`);
      results.forEach((r, i) => {
        console.log(`[${i + 1}] ${r.title}（分数 ${r.rerankScore ?? '-'}）`);
        console.log(`    ${r.url}`);
        console.log(`    ${(r.summary || r.snippet || '').slice(0, 120)}`);
      });
    }
  }

  if (!callCap) return;

  console.log(`\n── 真实调用 ${callCap} ──────────────────────────`);
  const started = Date.now();
  try {
    const res = await generate({
      capability: callCap,
      temperature: 0.1,
      messages: [{ role: 'user', parts: [{ type: 'text', text: PROMPTS[callCap] || '你好' }] }],
    });
    console.log(`provider=${res.provider} model=${res.model} 耗时=${Date.now() - started}ms`);
    if (res.usage) console.log(`tokens: in=${res.usage.inputTokens ?? '?'} out=${res.usage.outputTokens ?? '?'}`);
    console.log(`输出（前 300 字）：\n${res.text.slice(0, 300)}`);
  } catch (err) {
    const code = isLLMError(err) ? err.code : 'UNKNOWN';
    console.error(`调用失败 [${code}] ${errorMessage(err)}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('自检脚本异常：', err);
  process.exit(1);
});
