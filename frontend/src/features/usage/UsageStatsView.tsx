import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  Activity,
  BarChart3,
  Database,
  Eye,
  FileText,
  Gauge,
  Mic,
  RefreshCw,
  Timer,
  Volume2,
} from "lucide-react";
import { fetchUsageStats, type UsageBucket, type UsageEvent, type UsageStats, type UsageTotals } from "../../lib/api";
import type { CostSnapshot } from "../../types";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function timeLabel(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

const usageWindows = [7, 30, 90] as const;
const RECENT_EVENTS_PAGE_SIZE = 6;
const modalityLabels: Record<string, string> = {
  llm: "LLM 文本",
  vlm: "VLM 视觉",
  stt: "STT 语音识别",
  tts: "TTS 语音合成",
};

export function UsageStatsView({
  apiBaseUrl,
  cost,
  token,
}: {
  apiBaseUrl: string;
  cost: CostSnapshot;
  token: string;
}) {
  const [days, setDays] = useState<(typeof usageWindows)[number]>(7);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recentPage, setRecentPage] = useState(0);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStats(await fetchUsageStats(apiBaseUrl, token, days));
    } catch (statsError) {
      setError(statsError instanceof Error ? statsError.message : "用量统计加载失败");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, days, token]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    setRecentPage(0);
  }, [days]);

  const totals = stats?.totals ?? emptyUsageTotals();
  const actualTokens = totals.promptTokens + totals.completionTokens;
  const estimatedTokens = totals.estimatedPromptTokens + totals.estimatedCompletionTokens;
  const currentInputTokens = cost.llmInputTokens || cost.llmInputTokensEst;
  const currentOutputTokens = cost.llmOutputTokens || cost.llmOutputTokensEst;
  const recentEvents = stats?.recentEvents ?? [];
  const recentPageCount = Math.max(1, Math.ceil(recentEvents.length / RECENT_EVENTS_PAGE_SIZE));
  const safeRecentPage = Math.min(recentPage, recentPageCount - 1);
  const visibleRecentEvents = recentEvents.slice(
    safeRecentPage * RECENT_EVENTS_PAGE_SIZE,
    safeRecentPage * RECENT_EVENTS_PAGE_SIZE + RECENT_EVENTS_PAGE_SIZE,
  );

  return (
    <section className="min-h-full bg-white px-1 py-1 text-slate-950">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <div className="grid gap-4 border-b border-slate-300 pb-5 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="min-w-0">
            <h2 className="max-w-4xl text-3xl font-black leading-tight tracking-normal text-slate-950 md:text-5xl">
              模型消耗统计
            </h2>
          </div>
          <div className="grid content-end gap-3">
            <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
              {usageWindows.map((windowDays) => (
                <button
                  className={cx(
                    "h-9 rounded-lg border px-3 text-sm font-black transition",
                    days === windowDays
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-500",
                  )}
                  key={windowDays}
                  onClick={() => setDays(windowDays)}
                  type="button"
                >
                  {windowDays} 天
                </button>
              ))}
              <button
                className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:border-slate-500 disabled:opacity-50"
                disabled={loading}
                onClick={() => void loadStats()}
                title="刷新统计"
                type="button"
              >
                <RefreshCw className={cx(loading && "animate-spin")} size={16} />
              </button>
            </div>
            <div className="text-left text-xs font-bold text-slate-500 xl:text-right">
              {stats ? `统计至 ${dateTimeLabel(stats.generatedAt)}` : "等待统计数据"}
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageKpi icon={<Gauge size={19} />} label="估算计费单位" value={formatCompact(totals.estimatedUnits)} accent="bg-lime-300" />
          <UsageKpi icon={<BarChart3 size={19} />} label="真实 token" value={formatCompact(actualTokens)} subValue={`估算 ${formatCompact(estimatedTokens)}`} accent="bg-cyan-300" />
          <UsageKpi icon={<Timer size={19} />} label="STT 音频" value={formatDuration(totals.audioMs)} subValue={`有效语音 ${formatDuration(totals.speechMs)}`} accent="bg-amber-300" />
          <UsageKpi icon={<Volume2 size={19} />} label="TTS 输出" value={`${formatCompact(totals.ttsChars)} 字`} subValue={`音频 ${formatDuration(totals.ttsAudioMs)}`} accent="bg-rose-300" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[0.92fr_1.08fr]">
          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">当前会话实时快照</h3>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-black text-slate-500">{formatCompact(cost.estimatedUnits)} units</span>
            </div>
            <div className="grid gap-0 divide-y divide-slate-100">
              <UsageLine icon={<Mic size={16} />} label="STT 上传音频" value={formatSeconds(cost.audioSeconds)} detail={`有效语音 ${formatSeconds(cost.speechSeconds)} · ${cost.audioChunks} 帧`} />
              <UsageLine icon={<Eye size={16} />} label="VLM 图片输入" value={`${cost.visionFrames} 帧`} detail={`缓存命中 ${cost.visionCacheHits}`} />
              <UsageLine icon={<Activity size={16} />} label="LLM token" value={formatCompact(currentInputTokens + currentOutputTokens)} detail={`输入 ${formatCompact(currentInputTokens)} · 输出 ${formatCompact(currentOutputTokens)}`} />
              <UsageLine icon={<FileText size={16} />} label="TTS 输出" value={`${formatCompact(cost.ttsChars)} 字`} detail={`音频 ${formatSeconds(cost.ttsAudioSeconds ?? 0)} · 打断 ${cost.interruptions} 次`} />
            </div>
          </section>

          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">模态拆分</h3>
              <span className="text-xs font-bold text-slate-500">{totals.eventCount} 条计量事件</span>
            </div>
            <div className="grid gap-3 p-4">
              {stats?.modalities.length ? (
                stats.modalities.map((bucket) => (
                  <ModalityUsageBar key={bucket.modality} bucket={bucket} maxUnits={maxBucketUnits(stats.modalities)} />
                ))
              ) : (
                <EmptyUsageState text="还没有聚合事件。开始一次对话后，后台队列会写入新的计量事件。" />
              )}
            </div>
          </section>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_0.8fr]">
          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">每日趋势</h3>
              <span className="text-xs font-bold text-slate-500">{days} 天窗口</span>
            </div>
            <DailyUsageChart daily={stats?.daily ?? []} />
          </section>

          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">最近事件</h3>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-500">
                  {recentEvents.length ? `${safeRecentPage + 1} / ${recentPageCount}` : "0 / 0"}
                </span>
                <Database size={16} className="text-slate-400" />
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {visibleRecentEvents.length ? (
                visibleRecentEvents.map((event, index) => <RecentUsageEvent event={event} key={`${event.createdAt}-${safeRecentPage}-${index}`} />)
              ) : (
                <EmptyUsageState text="暂无事件记录。" />
              )}
            </div>
            {recentEvents.length > RECENT_EVENTS_PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
                <button
                  className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-black text-slate-600 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safeRecentPage === 0}
                  onClick={() => setRecentPage((page) => Math.max(0, page - 1))}
                  type="button"
                >
                  上一页
                </button>
                <span className="text-xs font-bold text-slate-500">
                  {safeRecentPage * RECENT_EVENTS_PAGE_SIZE + 1}-{Math.min((safeRecentPage + 1) * RECENT_EVENTS_PAGE_SIZE, recentEvents.length)} / {recentEvents.length}
                </span>
                <button
                  className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-black text-slate-600 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safeRecentPage >= recentPageCount - 1}
                  onClick={() => setRecentPage((page) => Math.min(recentPageCount - 1, page + 1))}
                  type="button"
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        </div>

        <section className="rounded-lg border border-slate-300 bg-white">
          <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] gap-3 border-b border-slate-200 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500 max-md:hidden">
            <span>会话</span>
            <span>token</span>
            <span>音频</span>
            <span>单位</span>
          </div>
          <div className="divide-y divide-slate-100">
            {stats?.conversations.length ? (
              stats.conversations.map((conversation) => <ConversationUsageRow conversation={conversation} key={conversation.id} />)
            ) : (
              <EmptyUsageState text="这个时间窗口内还没有会话用量。" />
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function emptyUsageTotals(): UsageTotals {
  return {
    eventCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    audioMs: 0,
    speechMs: 0,
    audioChunks: 0,
    ttsChars: 0,
    ttsAudioMs: 0,
    imageCount: 0,
    estimatedUnits: 0,
  };
}

function UsageKpi({
  accent,
  icon,
  label,
  subValue,
  value,
}: {
  accent: string;
  icon: React.ReactNode;
  label: string;
  subValue?: string;
  value: string;
}) {
  return (
    <article className="rounded-lg border border-slate-300 bg-white p-4">
      <div className="mb-5 flex items-center justify-between">
        <span className={cx("grid h-8 w-8 place-items-center rounded-lg text-slate-950", accent)}>{icon}</span>
        <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">{label}</span>
      </div>
      <strong className="block text-3xl font-black leading-none text-slate-950">{value}</strong>
      {subValue && <span className="mt-2 block text-xs font-bold text-slate-500">{subValue}</span>}
    </article>
  );
}

function UsageLine({ detail, icon, label, value }: { detail: string; icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-4 py-3">
      <span className="grid h-7 w-7 place-items-center rounded bg-slate-100 text-slate-600">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-black text-slate-900">{label}</span>
        <span className="block truncate text-xs font-semibold text-slate-500">{detail}</span>
      </span>
      <strong className="text-right text-lg font-black text-slate-950">{value}</strong>
    </div>
  );
}

function ModalityUsageBar({ bucket, maxUnits }: { bucket: UsageBucket; maxUnits: number }) {
  const width = maxUnits > 0 ? Math.max(5, Math.round((bucket.estimatedUnits / maxUnits) * 100)) : 0;
  const tokens = bucket.promptTokens + bucket.completionTokens || bucket.estimatedPromptTokens + bucket.estimatedCompletionTokens;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-black text-slate-900">{modalityLabels[bucket.modality ?? ""] ?? bucket.modality}</span>
        <span className="text-xs font-bold text-slate-500">
          {formatCompact(bucket.estimatedUnits)} units · {formatCompact(tokens)} token
        </span>
      </div>
      <div className="h-3 rounded bg-slate-100">
        <div className="h-3 rounded bg-slate-950" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 text-xs font-semibold text-slate-500">
        图片 {bucket.imageCount} · 音频 {formatDuration(bucket.audioMs)} · TTS {formatCompact(bucket.ttsChars)} 字
      </div>
    </div>
  );
}

function DailyUsageChart({ daily }: { daily: UsageBucket[] }) {
  if (!daily.length) return <EmptyUsageState text="暂无每日趋势。" />;
  const maxUnits = maxBucketUnits(daily);
  return (
    <div className="flex h-64 items-end gap-2 px-4 pb-4 pt-6">
      {daily.map((day) => {
        const height = maxUnits > 0 ? Math.max(8, Math.round((day.estimatedUnits / maxUnits) * 100)) : 0;
        return (
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2" key={day.day}>
            <div className="flex h-48 w-full items-end rounded bg-slate-100">
              <div className="w-full rounded bg-cyan-500" style={{ height: `${height}%` }} title={`${day.day}: ${day.estimatedUnits} units`} />
            </div>
            <span className="max-w-full truncate text-[11px] font-bold text-slate-500">{day.day?.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function RecentUsageEvent({ event }: { event: UsageEvent }) {
  const tokens = event.promptTokens + event.completionTokens || event.estimatedPromptTokens + event.estimatedCompletionTokens;
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="block truncate text-sm font-black text-slate-900">{modalityLabels[event.modality] ?? event.modality}</span>
        <span className="block truncate text-xs font-semibold text-slate-500">
          {event.metricType} · {event.model || event.provider}
        </span>
      </span>
      <span className="text-right text-xs font-bold text-slate-500">
        <strong className="block text-sm font-black text-slate-950">{tokens ? `${formatCompact(tokens)} token` : formatDuration(event.audioMs || event.ttsAudioMs)}</strong>
        {timeLabel(event.createdAt)}
      </span>
    </div>
  );
}

function ConversationUsageRow({ conversation }: { conversation: UsageBucket }) {
  const tokens = conversation.promptTokens + conversation.completionTokens || conversation.estimatedPromptTokens + conversation.estimatedCompletionTokens;
  return (
    <div className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] md:items-center">
      <span className="min-w-0">
        <span className="block truncate font-black text-slate-950">{conversation.title ?? "未命名会话"}</span>
        <span className="block text-xs font-semibold text-slate-500">{conversation.lastUsedAt ? dateTimeLabel(conversation.lastUsedAt) : "暂无时间"}</span>
      </span>
      <span className="font-bold text-slate-700">{formatCompact(tokens)}</span>
      <span className="font-bold text-slate-700">{formatDuration(conversation.audioMs)}</span>
      <span className="font-black text-slate-950">{formatCompact(conversation.estimatedUnits)}</span>
    </div>
  );
}

function EmptyUsageState({ text }: { text: string }) {
  return <p className="px-4 py-6 text-sm font-bold text-slate-500">{text}</p>;
}

function maxBucketUnits(buckets: UsageBucket[]) {
  return Math.max(0, ...buckets.map((bucket) => bucket.estimatedUnits));
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: value >= 10 ? 0 : 2 }).format(value);
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatSeconds(seconds: number) {
  return formatDuration(Math.round(seconds * 1000));
}

function dateTimeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
