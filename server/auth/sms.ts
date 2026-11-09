/**
 * 短信发送
 *
 * 业务代码只依赖 `SmsSender` 接口，具体走哪家由环境变量 `SMS_PROVIDER` 决定：
 *   console（默认，仅非生产环境）  不真发短信，把验证码打印在服务端日志里，用于本地开发
 *   aliyun                        阿里云短信服务，见 ./aliyunSms.ts（需要签名 + 模板 + AccessKey）
 *
 * 演练开关 `SMS_DRY_RUN`：开发环境默认开启（不调用阿里云、只打日志），生产默认关闭；
 * 显式写 0 才会真发，生产环境写 1 会直接拒绝启动。
 *
 * 开发期的固定验证码：`SMS_FIXED_CODE=123456`（6 位数字），所有手机号都收到同一个验证码，
 * 方便前端联调和自动化测试。**生产环境（NODE_ENV=production）配置了它会直接拒绝启动。**
 */
import { maskPhone } from './phone';
import { AliyunSmsSender, readAliyunSmsConfig } from './aliyunSms';
import type { AliyunSmsConfig } from './aliyunSms';

export interface SmsSender {
  readonly name: string;
  /** 发送登录验证码；失败时抛出异常 */
  sendLoginCode(phone: string, code: string): Promise<void>;
}

/** 开发用：不发短信，只在日志里打印验证码 */
export class ConsoleSmsSender implements SmsSender {
  readonly name = 'console';
  async sendLoginCode(phone: string, code: string): Promise<void> {
    console.log(`[SMS][console] 登录验证码 ${code} → ${maskPhone(phone)}（仅开发环境，不会真发短信）`);
  }
}

type Env = Record<string, string | undefined>;

/** 演练开关：开发阶段默认不真正调用短信 API；生产环境必须真发（配了会拒绝启动） */
export function isSmsDryRun(env: Env = process.env): boolean {
  const raw = (env.SMS_DRY_RUN || '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  // 没配置时：开发默认演练（省钱、也不受签名审批影响），生产默认真发
  return env.NODE_ENV !== 'production';
}

/** 演练用通道：签名 / 模板照常校验，但不发请求，只把「本该发什么」打到日志里 */
export class DryRunSmsSender implements SmsSender {
  readonly name = 'aliyun-dry-run';

  constructor(private readonly config: AliyunSmsConfig) {}

  async sendLoginCode(phone: string, code: string): Promise<void> {
    console.log(
      `[SMS][dry-run] 未调用阿里云。本应发送「${this.config.signName}」验证码 ${code} → ${maskPhone(phone)}` +
      `（模板 ${this.config.templateCode}，变量 ${this.config.templateParamName}）；要真发请设 SMS_DRY_RUN=0`,
    );
  }
}


export function createSmsSender(env: Env = process.env): SmsSender {
  const isProduction = env.NODE_ENV === 'production';
  const provider = (env.SMS_PROVIDER || (isProduction ? '' : 'console')).trim().toLowerCase();

  if (provider === 'console') {
    if (isProduction) throw new Error('生产环境不能使用 SMS_PROVIDER=console（验证码会打印在日志里）');
    return new ConsoleSmsSender();
  }
  if (provider === 'aliyun') {
    // 配置照常校验（签名、模板、AK 少哪个就报哪个），再决定真发还是演练
    const config = readAliyunSmsConfig(env);
    if (isSmsDryRun(env)) {
      if (isProduction) {
        throw new Error('生产环境不能开启 SMS_DRY_RUN（短信不会真的发出，用户收不到验证码）');
      }
      return new DryRunSmsSender(config);
    }
    return new AliyunSmsSender(config);
  }
  throw new Error(`未配置短信服务：请设置 SMS_PROVIDER（可选 console / aliyun），当前值「${provider}」`);
}

/** 读取开发用固定验证码；生产环境配置了就报错，格式不对也报错 */
export function getFixedCode(env: Env = process.env): string | null {
  const raw = (env.SMS_FIXED_CODE || '').trim();
  if (!raw) return null;
  if (env.NODE_ENV === 'production') throw new Error('生产环境不能配置 SMS_FIXED_CODE');
  if (!/^\d{6}$/.test(raw)) throw new Error('SMS_FIXED_CODE 必须是 6 位数字');
  return raw;
}
