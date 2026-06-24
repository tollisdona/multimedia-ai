import { useState } from "react";
import type React from "react";
import { loginUser, registerUser, type AuthSession } from "../../lib/api";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function AuthView({
  apiBaseUrl,
  error,
  onAuthenticated,
}: {
  apiBaseUrl: string;
  error: string;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState(error);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setLocalError("");
    try {
      const action = mode === "login" ? loginUser : registerUser;
      const session = await action(apiBaseUrl, username, password);
      onAuthenticated(session);
    } catch (authError) {
      setLocalError(authError instanceof Error ? authError.message : "认证失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-4 text-slate-950">
      <form className="w-full max-w-md rounded-[2rem] bg-white p-7 shadow-soft" onSubmit={submit}>
        <div className="mb-7">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-cyan-400 text-lg font-black">AI</div>
          <h1 className="text-2xl font-black">AI 视觉对话助手</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">登录后开始实时视觉对话，会话将按账号隔离。</p>
        </div>
        <div className="mb-5 grid grid-cols-2 rounded-2xl bg-slate-100 p-1 text-sm font-black">
          <button
            className={cx("rounded-xl py-2", mode === "login" ? "bg-white shadow-sm" : "text-slate-500")}
            type="button"
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            className={cx("rounded-xl py-2", mode === "register" ? "bg-white shadow-sm" : "text-slate-500")}
            type="button"
            onClick={() => setMode("register")}
          >
            注册
          </button>
        </div>
        <label className="mb-4 grid gap-2 text-sm font-bold text-slate-600">
          用户名
          <input
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none focus:border-cyan-400"
            minLength={3}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="mb-5 grid gap-2 text-sm font-bold text-slate-600">
          密码
          <input
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none focus:border-cyan-400"
            minLength={6}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>
        {localError && <div className="mb-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{localError}</div>}
        <button className="h-12 w-full rounded-2xl bg-emerald-700 font-black text-white hover:bg-emerald-800 disabled:opacity-60" disabled={loading}>
          {loading ? "处理中..." : mode === "login" ? "登录" : "创建账号"}
        </button>
      </form>
    </main>
  );
}

