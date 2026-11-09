/**
 * 思考模式（reasoning）对照压测
 *
 * 背景：DeepSeek 默认开启思考模式，实测 4 类问题平均慢 2.3 倍、output token 多 3.8 倍，
 * 而模板完整度不变。换模型 / 调参时用本脚本复测，别靠感觉。
 *
 * 用法：
 *   # 终端 1：默认实例
 *   cd server && PORT=3001 npm run dev
 *   # 终端 2：对照组（例如关掉思考）
 *   cd server && PORT=3002 DEEPSEEK_THINKING=disabled npm run dev
 *   # 终端 3：对比
 *   cd server && npm run bench-thinking
 *   cd server && npm run bench-thinking -- --iter 3 --label-b "思考关"
 *
 * 参数：--a / --b 两个 base url，--iter 每个问题重复次数，--token 复用已有令牌，
 *       --label-a / --label-b 展示名。未传 --token 时自动用开发固定验证码登录。
 *
 * 注意：两个实例共用同一个 SQLite，analysisWorker 会各自轮询；压测期间不要提交视频分析任务。
 * 指标里的 output tokens 已包含思考链 token（DeepSeek 按 output 计费）。
 */
import 'dotenv/config';

interface Run {
  ms: number;
  ok: boolean;
  intent: string;
  text: string;
  inTok: number;
  outTok: number;
  web: number;
}

interface Query {
  q: string;
  /** 期望出现的模板段落，用于检查「关掉思考会不会丢结构」 */
  markers: string[];
}

const QUERIES: Query[] = [
  { q: '正手攻球怎么练', markers: ['【动作要领】', '【常见问题】', '【训练建议】'] },
  { q: '打比赛时接发球总被压制怎么调整', markers: ['【存在问题', '【改进建议'] },
  { q: '张本智和最近一次比赛的成绩', markers: [] },
  { q: '蝴蝶王和狂飙龙5怎么选', markers: ['【性能特点】', '【适合打法】'] },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const A = arg('a', 'http://localhost:3001').replace(/\/+$/, '');
const B = arg('b', 'http://localhost:3002').replace(/\/+$/, '');
const ITER = Math.max(1, Number(arg('iter', '2')) || 2);
const LABEL_A = arg('label-a', 'A');
const LABEL_B = arg('label-b', 'B');

async function login(base: string): Promise<string> {
  const phone = process.env.BENCH_PHONE || '13800138000';
  const code = process.env.SMS_FIXED_CODE || '123456';
  await fetch(`${base}/api/v2/auth/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, consent: true }),
  }).catch(() => undefined);
  const res = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!json.token) {
    throw new Error(
      `${base} 登录失败：${JSON.stringify(json).slice(0, 160)}；可用 --token 或 BENCH_TOKEN 传已有令牌`
    );
  }
  return json.token;
}

async function call(base: string, token: string, q: string): Promise<Run> {
  const started = Date.now();
  const res = await fetch(`${base}/api/v2/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: q }),
  });
  const json: any = await res.json().catch(() => ({}));
  const cost = json.meta?.cost;
  return {
    ms: Date.now() - started,
    ok: json.success === true,
    intent: json.intent || json.error?.code || 'ERR',
    text: json.answerText || '',
    inTok: cost?.input_tokens ?? 0,
    outTok: cost?.output_tokens ?? 0,
    web: json.meta?.web_search_results ?? 0,
  };
}

const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

async function bench(label: string, base: string, token: string) {
  const rows: string[] = [];
  let totalMs = 0;
  let totalOut = 0;
  let totalChars = 0;

  for (const item of QUERIES) {
    const runs: Run[] = [];
    for (let i = 0; i < ITER; i++) {
      try {
        runs.push(await call(base, token, item.q));
      } catch (err: any) {
        runs.push({ ms: 0, ok: false, intent: 'NET_ERROR', text: '', inTok: 0, outTok: 0, web: 0 });
        console.warn(`  ! ${item.q} 请求失败：${err?.message || err}`);
      }
    }
    const ok = runs.filter(r => r.ok);
    if (ok.length === 0) {
      rows.push(`  ${item.q.padEnd(22)} 全部失败（${runs[0].intent}）`);
      continue;
    }
    const joined = ok.map(r => r.text).join('\n');
    const missing = item.markers.filter(m => !joined.includes(m));
    const ms = avg(ok.map(r => r.ms));
    const outTok = avg(ok.map(r => r.outTok));
    const chars = avg(ok.map(r => r.text.length));

    totalMs += ms;
    totalOut += outTok;
    totalChars += chars;

    rows.push(
      `  ${item.q.padEnd(22)} ${ok[0].intent.padEnd(15)} ${String(ms).padStart(6)}ms  out=${String(outTok).padStart(5)}  正文=${String(chars).padStart(4)}字  web=${ok[0].web}  缺段=${missing.join(',') || '-'}`
    );
  }

  console.log(`\n== ${label}（${base}）`);
  rows.forEach(r => console.log(r));
  console.log(`   合计：${totalMs}ms ｜ output tokens ${totalOut} ｜ 正文 ${totalChars} 字`);
  return { totalMs, totalOut, totalChars };
}

async function main(): Promise<void> {
  const tokenA = process.env.BENCH_TOKEN || (await login(A));
  // 两个实例共用 SQLite 时令牌通用；B 若独立部署会 401，此处回退到在 B 上重新登录
  let tokenB = process.env.BENCH_TOKEN || tokenA;
  const probe = await fetch(`${B}/api/v2/auth/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
  if (probe.status === 401) tokenB = await login(B);

  console.log(`每问重复 ${ITER} 次；output tokens 含思考链`);
  const a = await bench(LABEL_A, A, tokenA);
  const b = await bench(LABEL_B, B, tokenB);

  const ratio = (x: number, y: number) => (y > 0 ? (x / y).toFixed(2) : '-');
  console.log('\n== 对比 ============================================');
  console.log(`  耗时：${a.totalMs}ms → ${b.totalMs}ms（${ratio(a.totalMs, b.totalMs)}×）`);
  console.log(`  output tokens：${a.totalOut} → ${b.totalOut}（${ratio(a.totalOut, b.totalOut)}×）`);
  console.log(`  正文长度：${a.totalChars} 字 → ${b.totalChars} 字（${ratio(a.totalChars, b.totalChars)}×）`);
}

main().catch(err => {
  console.error('压测失败：', err?.message || err);
  process.exit(1);
});
