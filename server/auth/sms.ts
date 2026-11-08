/**
 * 短信发送
 *
 * 业务代码只依赖 `SmsSender` 接口，具体走哪家由环境变量 `SMS_PROVIDER` 决定：
 *   console（默认，仅非生产环境）  不真发短信，把验证码打印在服务端日志里，用于本地开发
 *   aliyun                        阿里云短信服务 —— 尚未接入（等短信签名和模板审核通过后实现）
 *
 * 开发期的固定验证码：`SMS_FIXED_CODE=123456`（6 位数字），所有手机号都收到同一个验证码，
 * 方便前端联调和自动化测试。**生产环境（NODE_ENV=production）配置了它会直接拒绝启动。**
 */
import { maskPhone } from './phone';

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

export function createSmsSender(env: Env = process.env): SmsSender {
  const isProduction = env.NODE_ENV === 'production';
  const provider = (env.SMS_PROVIDER || (isProduction ? '' : 'console')).trim().toLowerCase();

  if (provider === 'console') {
    if (isProduction) throw new Error('生产环境不能使用 SMS_PROVIDER=console（验证码会打印在日志里）');
    return new ConsoleSmsSender();
  }
  if (provider === 'aliyun') {
    throw new Error('SMS_PROVIDER=aliyun 尚未实现：需要先有阿里云短信签名和模板（见 docs/arch/Topstar_上线检查清单.md 账号体系一节）');
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
