/**
 * 登录态（前端）
 *
 * - 令牌和用户信息存在 localStorage（`topstar-auth`），刷新页面不丢；隐私模式写不进去时退化为内存
 * - 所有需要登录的接口都通过 `authedFetch` 调用：自动带 `Authorization: Bearer <令牌>`，
 *   遇到 401 说明登录失效，清掉本地登录态并弹出登录窗口
 * - 登录窗口由 `LoginModal`（挂在 App 里）负责展示；任何地方想要用户登录，调用 `requestLogin(原因)` 即可。
 *   登录成功后窗口关闭，**不会**自动继续刚才的操作（iOS 要求选文件、播放声音必须发生在用户点击里），
 *   由用户再点一次
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'topstar-auth';

export interface AuthUser {
  id: string;
  phoneMasked: string;
}

interface StoredSession {
  token: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  user: AuthUser;
}

export interface AuthState {
  user: AuthUser | null;
  /** 不为空表示正在显示登录窗口，值是展示给用户的原因 */
  loginPrompt: string | null;
  /** 登录成功后的短暂提示 */
  notice: string | null;
}

/** 后端返回的业务错误（验证码错误、发送太频繁等），message 可以直接展示给用户 */
export class AuthApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
    this.name = 'AuthApiError';
  }
}

/** 登录失效（令牌过期、被注销）；message 可以直接展示给用户 */
export class AuthRequiredError extends Error {
  constructor(message = '登录已过期，请重新登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

// ─── 存储 ────────────────────────────────────────────────────────────────────

let memorySession: StoredSession | null = null;

function readStored(): StoredSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memorySession && memorySession.expiresAt > Date.now() ? memorySession : null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    if (typeof s.token === 'string' && typeof s.expiresAt === 'number' && s.expiresAt > Date.now() && s.user?.id) {
      return s;
    }
  } catch { /* 损坏的数据当作没登录 */ }
  return null;
}

function writeStored(s: StoredSession | null) {
  memorySession = s;
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 隐私模式：只保留内存 */ }
}

// ─── 状态 ────────────────────────────────────────────────────────────────────

let session: StoredSession | null = readStored();
let state: AuthState = { user: session?.user ?? null, loginPrompt: null, notice: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

function setSession(s: StoredSession | null) {
  session = s;
  writeStored(s);
  setState({ user: s?.user ?? null });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = () => state;

export function useAuthState(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// 其他标签页登录 / 退出时同步
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { // icon-check-ignore：'storage' 是事件名，不是图标
    if (e.key !== STORAGE_KEY) return;
    session = readStored();
    setState({ user: session?.user ?? null });
  });
}

/** 当前令牌；没登录或已过期返回 null */
export function getToken(): string | null {
  if (session && session.expiresAt <= Date.now()) {
    setSession(null);
  }
  return session?.token ?? null;
}

export const isLoggedIn = () => getToken() !== null;

// ─── 登录窗口 ────────────────────────────────────────────────────────────────

export function requestLogin(reason: string) {
  setState({ loginPrompt: reason });
}

export function closeLogin() {
  setState({ loginPrompt: null });
}

export function clearNotice() {
  setState({ notice: null });
}

// ─── 接口 ────────────────────────────────────────────────────────────────────

async function postAuth<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthApiError('NETWORK_ERROR', '网络连接失败，请检查网络后重试');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new AuthApiError(
      data.error?.code || 'UNKNOWN',
      data.error?.message || '服务暂时不可用，请稍后重试',
      data.error?.retry_after,
    );
  }
  return data as T;
}

/** 发送验证码；返回多少秒后可以重新获取 */
export async function sendSmsCode(phone: string, consent: boolean): Promise<number> {
  const data = await postAuth<{ resend_after: number }>('/api/v2/auth/sms/send', { phone, consent });
  return data.resend_after ?? 60;
}

export async function loginWithCode(phone: string, code: string): Promise<void> {
  const data = await postAuth<{ token: string; expires_at: number; user: { id: string; phone_masked: string } }>(
    '/api/v2/auth/login',
    { phone, code },
  );
  setSession({
    token: data.token,
    expiresAt: data.expires_at,
    user: { id: data.user.id, phoneMasked: data.user.phone_masked },
  });
  setState({ loginPrompt: null, notice: '登录成功，请继续刚才的操作' });
}

/** 退出登录：本地立即清除，服务端令牌尽力注销（失败也不影响退出） */
export async function logout(): Promise<void> {
  const token = session?.token;
  setSession(null);
  if (token) {
    try {
      await fetch('/api/v2/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch { /* 忽略 */ }
  }
}

/** 启动时向服务端确认登录态仍然有效；只有明确 401 才清除，网络问题不影响已登录状态 */
export async function refreshSession(): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch('/api/v2/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) setSession(null);
  } catch { /* 网络问题：保持现状 */ }
}

/**
 * 带登录令牌的 fetch。
 * 401 时清除本地登录态；默认同时弹出登录窗口（后台自动发起的请求传 `promptOnUnauthorized: false`），
 * 并抛出 AuthRequiredError。
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
  opts: { promptOnUnauthorized?: boolean } = {},
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    const hadToken = token !== null;
    if (hadToken) setSession(null);
    const message = hadToken ? '登录已过期，请重新登录' : '请先登录';
    if (opts.promptOnUnauthorized !== false) requestLogin(message);
    throw new AuthRequiredError(message);
  }
  return res;
}
