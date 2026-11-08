import React, { useEffect, useRef, useState } from 'react';
import {
  AuthApiError,
  clearNotice,
  closeLogin,
  loginWithCode,
  sendSmsCode,
  useAuthState,
} from '../utils/auth.ts';

const PHONE_REGEX = /^1[3-9]\d{9}$/;

/**
 * 登录窗口（手机号 + 短信验证码）
 *
 * 由 `requestLogin(原因)` 触发显示。没有账号的手机号登录时自动注册。
 * 必须勾选同意《用户协议》和《隐私政策》才能获取验证码（合规要求）。
 */
const LoginModal: React.FC = () => {
  const { loginPrompt, notice } = useAuthState();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const open = loginPrompt !== null;

  // 窗口关闭后清掉验证码和错误（手机号和勾选保留，方便重新打开）
  useEffect(() => {
    if (!open) {
      setCode('');
      setError(null);
    }
  }, [open]);

  // 重新获取验证码的倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLogin(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 登录成功后的提示 2.5 秒自动消失
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const phoneValid = PHONE_REGEX.test(phone);
  const canSubmit = phoneValid && /^\d{6}$/.test(code) && consent && !submitting;

  const handleSend = async () => {
    if (sending || cooldown > 0) return;
    if (!phoneValid) { setError('请输入正确的 11 位手机号'); return; }
    if (!consent) { setError('请先阅读并同意《用户协议》和《隐私政策》'); return; }
    setError(null);
    setSending(true);
    try {
      const wait = await sendSmsCode(phone, true);
      setCooldown(wait);
      codeInputRef.current?.focus();
    } catch (err) {
      if (err instanceof AuthApiError && err.retryAfter) setCooldown(err.retryAfter);
      setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await loginWithCode(phone, code);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {notice && (
        <div
          role="status"
          className="absolute top-20 left-1/2 -translate-x-1/2 z-[1300] px-4 py-2.5 rounded-full bg-slate-900/90 dark:bg-white/90 text-white dark:text-slate-900 text-[13px] font-medium shadow-lg animate-fade-in-up whitespace-nowrap"
        >
          {notice}
        </div>
      )}

      {open && (
        <div
          className="absolute inset-0 z-[1200] flex items-end bg-black/50 backdrop-blur-[2px]"
          onClick={closeLogin}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-3xl bg-white dark:bg-[#16222c] border-t border-slate-200 dark:border-white/10 px-6 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl animate-fade-in-up"
          >
            <div className="flex items-start justify-between mb-5">
              <div>
                <h2 id="login-title" className="text-slate-900 dark:text-white font-bold text-xl tracking-tight">手机号登录</h2>
                <p className="text-slate-500 dark:text-white/50 text-[13px] mt-1">{loginPrompt}</p>
              </div>
              <button
                type="button"
                onClick={closeLogin}
                aria-label="关闭"
                className="size-9 -mr-2 -mt-1 rounded-full flex items-center justify-center text-slate-400 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/10 active:scale-90 transition-all"
              >
                <span className="material-symbols-outlined text-[22px]">close</span>
              </button>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-3 bg-slate-100 dark:bg-[#1e2933] border border-slate-200 dark:border-white/10 rounded-xl px-4 h-12 focus-within:border-primary/60 transition-colors">
                <span className="text-slate-500 dark:text-white/60 text-[15px] font-medium shrink-0">+86</span>
                <input
                  autoFocus
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="请输入手机号"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  className="flex-1 min-w-0 bg-transparent border-none p-0 focus:ring-0 text-[15px] text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-white/25"
                />
              </label>

              <div className="flex gap-3">
                <label className="flex-1 min-w-0 flex items-center bg-slate-100 dark:bg-[#1e2933] border border-slate-200 dark:border-white/10 rounded-xl px-4 h-12 focus-within:border-primary/60 transition-colors">
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="请输入验证码"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="w-full bg-transparent border-none p-0 focus:ring-0 text-[15px] text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-white/25 tracking-widest"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={sending || cooldown > 0 || !phoneValid}
                  className="shrink-0 w-[112px] h-12 rounded-xl text-[13px] font-bold bg-primary/10 text-primary disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
                >
                  {sending ? '发送中…' : cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </button>
              </div>
            </div>

            <label className="flex items-start gap-2.5 mt-4 text-[12px] leading-relaxed text-slate-500 dark:text-white/50 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 size-4 rounded border-slate-300 dark:border-white/20 text-primary focus:ring-primary/40"
              />
              <span>
                我已阅读并同意
                <span className="text-primary">《用户协议》</span>和<span className="text-primary">《隐私政策》</span>
                ，未注册的手机号验证后将自动创建账号
              </span>
            </label>

            <div className="min-h-[20px] mt-3 text-[13px] text-red-500" role="alert">{error}</div>

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full h-12 mt-1 rounded-xl bg-gradient-to-br from-primary to-purple-500 text-white font-bold text-[15px] shadow-lg shadow-primary/30 disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed active:scale-[0.98] transition-all"
            >
              {submitting ? '登录中…' : '登录 / 注册'}
            </button>
          </form>
        </div>
      )}
    </>
  );
};

export default LoginModal;
