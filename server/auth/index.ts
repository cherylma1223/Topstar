/**
 * 账号服务的进程内单例（接真实数据库和环境变量）
 *
 * 启动时调用 `initAuthService()`，配置有问题（缺 AUTH_SECRET、生产环境用了控制台短信等）
 * 会直接抛错，让服务启动失败，而不是带着不安全的配置上线。
 */
import db from '../db';
import { AuthService, getAuthSecret } from './service';
import { createSmsSender, getFixedCode } from './sms';

let instance: AuthService | null = null;

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 必须是正数，当前值「${raw}」`);
  return n;
}

export function initAuthService(): AuthService {
  const fixed = getFixedCode();
  const sender = createSmsSender();
  const sessionDays = intFromEnv('AUTH_SESSION_DAYS');
  instance = new AuthService(db, {
    secret: getAuthSecret(),
    sender,
    generateCode: fixed ? () => fixed : undefined,
    sessionTtlMs: sessionDays ? sessionDays * 24 * 60 * 60 * 1000 : undefined,
    phoneDailyLimit: intFromEnv('SMS_PHONE_DAILY_LIMIT'),
    ipDailyLimit: intFromEnv('SMS_IP_DAILY_LIMIT'),
  });
  console.log(`[Auth] 账号服务已启动（短信：${sender.name}${fixed ? '，使用固定验证码（仅开发）' : ''}）`);
  return instance;
}

export function getAuthService(): AuthService {
  if (!instance) throw new Error('账号服务尚未初始化（应在 index.ts 启动时调用 initAuthService）');
  return instance;
}

/** 仅测试用：注入 / 清除账号服务 */
export function __setAuthServiceForTest(service: AuthService | null): void {
  instance = service;
}
