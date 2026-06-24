import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  BarChart3,
  Check,
  History,
  KeyRound,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SlidersHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { AuthSession } from "../../lib/api";

const NEW_SESSION_BUSY_ID = "__new_session__";
type SessionListItem = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function HistoryRail({
  busySessionId,
  collapsed,
  currentSessionId,
  error,
  onDeleteSession,
  onNewSession,
  onLogout,
  onOpenApiKeys,
  onOpenSettings,
  onOpenUsage,
  onRenameSession,
  onSelectSession,
  onToggle,
  sessions,
  user,
}: {
  busySessionId: string | null;
  collapsed: boolean;
  currentSessionId: string;
  error: string;
  onDeleteSession: (id: string) => Promise<void>;
  onNewSession: () => Promise<void>;
  onLogout: () => Promise<void>;
  onOpenApiKeys: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  onToggle: () => void;
  sessions: SessionListItem[];
  user: AuthSession["user"];
}) {
  const initials = user.username.slice(0, 1).toUpperCase();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleUserMenu = useCallback(() => {
    setMenuOpen((current) => !current);
  }, []);

  const openSettings = useCallback(() => {
    setMenuOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  const openApiKeys = useCallback(() => {
    setMenuOpen(false);
    onOpenApiKeys();
  }, [onOpenApiKeys]);

  const openUsage = useCallback(() => {
    setMenuOpen(false);
    onOpenUsage();
  }, [onOpenUsage]);

  const logoutFromMenu = useCallback(() => {
    setMenuOpen(false);
    void onLogout();
  }, [onLogout]);

  const createSessionFromRail = useCallback(() => {
    setMenuOpen(false);
    return onNewSession();
  }, [onNewSession]);

  const selectSessionFromRail = useCallback(
    (id: string) => {
      setMenuOpen(false);
      return onSelectSession(id);
    },
    [onSelectSession],
  );

  const toggleRail = useCallback(() => {
    setMenuOpen(false);
    onToggle();
  }, [onToggle]);

  const userMenu = menuOpen ? (
    <div
      className={cx(
        "absolute z-20 rounded-2xl border border-slate-200 bg-white p-2 text-sm font-semibold text-slate-700 shadow-xl",
        collapsed ? "bottom-16 left-3 w-60" : "bottom-20 left-3 right-3",
      )}
    >
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openSettings} type="button">
        <SlidersHorizontal size={17} /> 系统设置
      </button>
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openApiKeys} type="button">
        <KeyRound size={17} /> API Key 管理
      </button>
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openUsage} type="button">
        <BarChart3 size={17} /> 模型消耗统计
      </button>
      <button className="mt-1 flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-rose-600 hover:bg-rose-50" onClick={logoutFromMenu} type="button">
        <LogOut size={17} /> 用户登出
      </button>
    </div>
  ) : null;

  if (collapsed) {
    return (
      <aside className="relative flex flex-col items-center gap-3 border-r border-slate-200 bg-slate-50 py-3 max-lg:hidden">
        <button
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-700 hover:bg-slate-100"
          onClick={toggleRail}
          title="展开历史记录"
          type="button"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busySessionId === NEW_SESSION_BUSY_ID}
          onClick={createSessionFromRail}
          title="新会话"
          type="button"
        >
          <Plus size={18} />
        </button>
        {userMenu}
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            className="grid h-10 w-10 place-items-center rounded-xl text-slate-600 hover:bg-slate-100"
            onClick={toggleUserMenu}
            aria-label="打开用户菜单"
            title="用户菜单"
            type="button"
          >
            <MoreHorizontal size={18} />
          </button>
          <button
            className="grid h-10 w-10 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white"
            onClick={openSettings}
            title="系统设置"
            type="button"
          >
            {initials}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-slate-200 bg-slate-50 p-3 max-lg:hidden">
      <div className="mb-4 flex gap-2">
        <button
          className="flex h-11 flex-1 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busySessionId === NEW_SESSION_BUSY_ID}
          onClick={createSessionFromRail}
          type="button"
        >
          <Plus size={17} /> {busySessionId === NEW_SESSION_BUSY_ID ? "创建中..." : "新会话"}
        </button>
        <button className="grid h-11 w-11 place-items-center rounded-xl text-slate-600 hover:bg-slate-100" onClick={toggleRail} title="收起历史记录" type="button">
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2 px-2 text-xs font-bold text-slate-500">
        <History size={15} /> 最近
      </div>
      {error && <p className="mb-3 rounded-2xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p>}
      <div className="min-h-0 flex-1 space-y-1 overflow-auto">
        {sessions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">暂无会话历史</p>
        ) : (
          sessions.map((session) => (
            <HistorySessionItem
              key={session.id}
              active={session.id === currentSessionId}
              busy={busySessionId === session.id}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onSelectSession={selectSessionFromRail}
              session={session}
            />
          ))
        )}
      </div>
      {userMenu}
      <div className="mt-3 flex h-12 items-center gap-2 rounded-xl px-2 hover:bg-slate-100">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={openSettings} type="button">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white">
            {initials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{user.username}</span>
            <span className="block text-xs text-slate-500">用户管理与设置</span>
          </span>
        </button>
        <button
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 hover:bg-white hover:text-slate-900"
          onClick={toggleUserMenu}
          aria-label="打开用户菜单"
          title="更多用户选项"
          type="button"
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    </aside>
  );
}

function HistorySessionItem({
  active,
  busy,
  onDeleteSession,
  onRenameSession,
  onSelectSession,
  session,
}: {
  active: boolean;
  busy: boolean;
  onDeleteSession: (id: string) => Promise<void>;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  session: SessionListItem;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);

  useEffect(() => {
    if (!isEditing) setDraftTitle(session.title);
  }, [isEditing, session.title]);

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = draftTitle.trim();
    if (!clean || clean === session.title) {
      setIsEditing(false);
      setDraftTitle(session.title);
      return;
    }
    try {
      await onRenameSession(session.id, clean);
      setIsEditing(false);
    } catch {
      // Error is rendered by the history rail.
    }
  };

  const deleteCurrentSession = async () => {
    if (!window.confirm(`删除会话「${session.title}」？`)) return;
    try {
      await onDeleteSession(session.id);
    } catch {
      // Error is rendered by the history rail.
    }
  };

  return (
    <article
      className={cx(
        "rounded-xl px-2 py-2 transition",
        active ? "bg-slate-200/70 text-slate-950" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {isEditing ? (
        <form className="grid gap-2" onSubmit={submitRename}>
          <input
            autoFocus
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-cyan-400"
            disabled={busy}
            maxLength={80}
            onChange={(event) => setDraftTitle(event.target.value)}
            value={draftTitle}
          />
          <div className="flex justify-end gap-1">
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setIsEditing(false);
                setDraftTitle(session.title);
              }}
              title="取消重命名"
              type="button"
            >
              <X size={16} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-xl bg-slate-950 text-white disabled:opacity-50"
              disabled={busy || !draftTitle.trim()}
              title="保存会话名称"
              type="submit"
            >
              <Check size={16} />
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <button
            className="min-w-0 flex-1 text-left"
            disabled={busy}
            onClick={() => void onSelectSession(session.id)}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-black">
              <MessageSquare className="shrink-0" size={15} />
              <span className="truncate">{session.title}</span>
            </span>
            <span className="mt-1 block text-xs font-medium text-slate-400">
              {session.updatedAt} · {session.messageCount} 条消息
            </span>
          </button>
          <div className="flex shrink-0 gap-1">
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => setIsEditing(true)}
              title="重命名会话"
              type="button"
            >
              <Pencil size={15} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void deleteCurrentSession()}
              title="删除会话"
              type="button"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
