/**
 * 远程访问的登录关卡与二次口令弹框。
 * 两个凭证都不落任何本地存储:登录靠 httpOnly cookie(JS 读不到),二次口令只驻内存。
 */
import { useEffect, useRef, useState } from 'react';
import { auth } from '@/api/client';
import { registerSecretPrompt } from '@/lib/auth';

export function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(password);
      setPassword('');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">璇玑</div>
        <p className="login-sub">远程访问需要登录口令</p>
        <input
          ref={inputRef}
          className="input login-input"
          type="password"
          autoComplete="current-password"
          placeholder="登录口令"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="登录口令"
          aria-invalid={Boolean(error)}
        />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="btn btn-primary login-submit" type="submit" disabled={busy || !password.trim()}>
          {busy ? '验证中…' : '登录'}
        </button>
        <p className="login-foot">会话有效期 7 天;在别处登录会使当前会话失效。</p>
      </form>
    </div>
  );
}

/**
 * 二次口令弹框。挂在 App 层,由 lib/auth 的 ensureConfirmToken 唤起。
 * 与 ConfirmHost 同款遮罩,但走表单语义(密码框 + Enter 提交)。
 */
export function SecretPromptHost() {
  const [req, setReq] = useState<{ title: string; hint?: string; resolve: (v: string | null) => void } | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerSecretPrompt(
      (opts) =>
        new Promise<string | null>((resolve) => {
          setValue('');
          setReq({ ...opts, resolve });
        }),
    );
    return () => registerSecretPrompt(null);
  }, []);

  useEffect(() => {
    if (req) inputRef.current?.focus();
  }, [req]);

  const done = (v: string | null) => {
    req?.resolve(v);
    setReq(null);
    setValue('');
  };

  if (!req) return null;
  return (
    <div className="confirm-mask" onClick={() => done(null)}>
      <form
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          done(value.trim() ? value : null);
        }}
      >
        <p className="secret-title">{req.title}</p>
        {req.hint && <p className="secret-hint">{req.hint}</p>}
        <input
          ref={inputRef}
          className="input"
          type="password"
          autoComplete="off"
          placeholder="二次确认口令"
          value={value}
          aria-label={req.title}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 吃掉 Esc,避免同一按键继续传给看板键盘导航
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              done(null);
            }
          }}
        />
        <div className="confirm-actions">
          <button type="button" className="btn btn-sm" onClick={() => done(null)}>取消(Esc)</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!value.trim()}>确认(Enter)</button>
        </div>
      </form>
    </div>
  );
}
