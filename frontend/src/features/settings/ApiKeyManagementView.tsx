import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  fetchModelConfig,
  updateModelConfig,
  type ModelConfig,
  type ModelConfigUpdate,
} from "../../lib/api";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type ModelConfigForm = ModelConfigUpdate & { apiKey: string };
type ProviderPreset = {
  id: string;
  name: string;
  badge?: string;
  description: string;
  baseUrl: string;
  chatModel: string;
  supportsRealtime: boolean;
  realtimeEnabled: boolean;
  realtimeBaseUrl: string;
  realtimeModel: string;
  realtimeVoice: string;
};

const providerPresets: ProviderPreset[] = [
  {
    id: "dashscope",
    name: "阿里云百炼",
    badge: "Omni",
    description: "DashScope 兼容模式，支持 Qwen Omni Realtime。",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatModel: "qwen3.5-omni-plus",
    supportsRealtime: true,
    realtimeEnabled: true,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    badge: "常用",
    description: "DeepSeek 官方 OpenAI 兼容接口。",
    baseUrl: "https://api.deepseek.com",
    chatModel: "deepseek-chat",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    description: "智谱开放平台 GLM 系列模型。",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    chatModel: "glm-4.5",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    description: "月之暗面 Kimi OpenAI 兼容接口。",
    baseUrl: "https://api.moonshot.cn/v1",
    chatModel: "kimi-k2-0711-preview",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "baidu",
    name: "百度千帆",
    description: "千帆 ModelBuilder OpenAI 兼容入口。",
    baseUrl: "https://qianfan.baidubce.com/v2",
    chatModel: "ernie-4.5-turbo-vl",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "tencent",
    name: "腾讯混元",
    description: "混元 OpenAI 兼容 Chat Completions。",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    chatModel: "hunyuan-turbos-vision",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "volcengine",
    name: "火山方舟",
    description: "火山引擎方舟推理接入点。",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    chatModel: "doubao-1-5-vision-pro-32k",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    badge: "聚合",
    description: "国内聚合平台，适合快速切模型。",
    baseUrl: "https://api.siliconflow.cn/v1",
    chatModel: "Qwen/Qwen2.5-VL-72B-Instruct",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax Open Platform 兼容接口。",
    baseUrl: "https://api.minimax.chat/v1",
    chatModel: "abab6.5s-chat",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "国际",
    description: "多模型路由，可填任意 OpenRouter 模型。",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModel: "qwen/qwen2.5-vl-72b-instruct",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
];

function modelConfigToForm(config: ModelConfig): ModelConfigForm {
  return {
    apiKey: "",
    baseUrl: config.baseUrl,
    chatModel: config.chatModel,
    realtimeEnabled: config.realtimeEnabled,
    realtimeBaseUrl: config.realtimeBaseUrl,
    realtimeModel: config.realtimeModel,
    realtimeVoice: config.realtimeVoice,
  };
}

function keySourceLabel(config: ModelConfig | null) {
  if (!config) return "读取中";
  if (config.keySource === "user") return `用户密钥 ${config.keyPreview}`;
  if (config.keySource === "environment") return "使用后端环境变量";
  return "未配置";
}

function normalizeUrlForPreset(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function findMatchingPreset(form: ModelConfigForm | null) {
  if (!form) return null;
  return providerPresets.find((preset) => normalizeUrlForPreset(preset.baseUrl) === normalizeUrlForPreset(form.baseUrl)) ?? null;
}

export function ApiKeyManagementView({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [form, setForm] = useState<ModelConfigForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedPreset = useMemo(() => findMatchingPreset(form), [form]);
  const realtimeConfigVisible = !selectedPreset || selectedPreset.supportsRealtime;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchModelConfig(apiBaseUrl, token);
      setConfig(next);
      setForm(modelConfigToForm(next));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const updateForm = useCallback(
    <Key extends keyof ModelConfigForm>(key: Key, value: ModelConfigForm[Key]) => {
      setForm((current) => (current ? { ...current, [key]: value } : current));
      setMessage("");
      setError("");
    },
    [],
  );

  const saveConfig = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!form) return;
      setSaving(true);
      setError("");
      try {
        const payload: ModelConfigUpdate = {
          baseUrl: form.baseUrl,
          chatModel: form.chatModel,
          realtimeEnabled: form.realtimeEnabled,
          realtimeBaseUrl: form.realtimeBaseUrl,
          realtimeModel: form.realtimeModel,
          realtimeVoice: form.realtimeVoice,
        };
        if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        const next = await updateModelConfig(apiBaseUrl, token, payload);
        setConfig(next);
        setForm(modelConfigToForm(next));
        setMessage("模型配置已保存，新会话连接会使用最新配置。");
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "保存配置失败");
      } finally {
        setSaving(false);
      }
    },
    [apiBaseUrl, form, token],
  );

  const clearApiKey = useCallback(async () => {
    if (!form) return;
    setClearing(true);
    setError("");
    try {
      const next = await updateModelConfig(apiBaseUrl, token, {
        ...form,
        apiKey: undefined,
        clearApiKey: true,
      });
      setConfig(next);
      setForm(modelConfigToForm(next));
      setMessage("用户 API Key 已清除。");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "清除密钥失败");
    } finally {
      setClearing(false);
    }
  }, [apiBaseUrl, form, token]);

  const applyPreset = useCallback((preset: ProviderPreset) => {
    setForm((current) => {
      const keepApiKey = current?.apiKey ?? "";
      return {
        apiKey: keepApiKey,
        baseUrl: preset.baseUrl,
        chatModel: preset.chatModel,
        realtimeEnabled: preset.realtimeEnabled,
        realtimeBaseUrl: preset.realtimeBaseUrl,
        realtimeModel: preset.realtimeModel,
        realtimeVoice: preset.realtimeVoice,
      };
    });
    setMessage(`已套用 ${preset.name} 预设，检查 API Key 后保存。`);
    setError("");
  }, []);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col pb-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase text-emerald-700">Model switchboard</p>
          <h2 className="mt-1 text-3xl font-black text-slate-950">API Key 管理</h2>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-slate-500">
            选择供应商预设后填入密钥；自定义 Base URL 和模型名仍可直接编辑。
          </p>
        </div>
        <div className="min-w-[13rem] rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="block text-xs font-black text-slate-400">当前密钥</span>
          <strong className={cx("mt-1 block text-sm", config?.keyConfigured ? "text-emerald-700" : "text-rose-700")}>
            {keySourceLabel(config)}
          </strong>
        </div>
      </div>
      {loading && <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-bold text-slate-500">正在读取配置...</div>}
      {!loading && form && (
        <form className="grid min-h-0 gap-5 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]" onSubmit={saveConfig}>
          <aside className="self-start rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-black text-slate-950">预设供应商</h3>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-500">
                {selectedPreset?.name ?? "自定义"}
              </span>
            </div>
            <div className="grid max-h-[calc(100vh-17rem)] gap-2 overflow-y-auto pr-1 max-lg:max-h-none max-lg:grid-cols-2 max-sm:grid-cols-1">
              {providerPresets.map((preset) => {
                const active = selectedPreset?.id === preset.id;
                return (
                  <button
                    aria-pressed={active}
                    className={cx(
                      "group min-w-0 rounded-2xl border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-500",
                      active
                        ? "border-emerald-700 bg-emerald-700 text-white shadow-[0_12px_30px_rgba(4,120,87,0.18)]"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white",
                    )}
                    key={preset.id}
                    onClick={() => applyPreset(preset)}
                    type="button"
                    >
                      <span className="flex min-w-0 items-center justify-between gap-3">
                      <strong className="truncate text-[15px] font-black">{preset.name}</strong>
                      {preset.badge && (
                        <span
                          className={cx(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black",
                            active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-700",
                          )}
                        >
                          {preset.badge}
                        </span>
                      )}
                    </span>
                    <span className={cx("mt-1 block truncate text-xs font-semibold", active ? "text-emerald-50" : "text-slate-500")}>
                      {preset.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-w-0 rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-lg font-black text-slate-950">
                    {selectedPreset ? selectedPreset.name : "自定义配置"}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">当前会话保持不变，新建或重连后使用保存的配置。</p>
                </div>
                {realtimeConfigVisible ? (
                  <label className="flex h-10 shrink-0 items-center gap-3 rounded-2xl bg-slate-100 px-3 text-sm font-black text-slate-700">
                    Realtime
                    <input
                      checked={form.realtimeEnabled}
                      className="h-5 w-5 accent-emerald-700"
                      disabled={Boolean(selectedPreset && !selectedPreset.supportsRealtime)}
                      onChange={(event) => updateForm("realtimeEnabled", event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                ) : (
                  <span className="h-10 shrink-0 rounded-2xl bg-slate-100 px-3 pt-2.5 text-sm font-black text-slate-500">
                    Chat / Vision
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-4 px-5 py-5">
              <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                API Key
                <input
                  autoComplete="off"
                  className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                  onChange={(event) => updateForm("apiKey", event.target.value)}
                  placeholder={config?.keyConfigured ? "留空表示保留当前密钥" : "输入模型服务 API Key"}
                  type="password"
                  value={form.apiKey}
                />
              </label>

              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                  Base URL
                  <input
                    className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                    onChange={(event) => updateForm("baseUrl", event.target.value)}
                    required
                    value={form.baseUrl}
                  />
                </label>
                <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                  对话 / 视觉模型
                  <input
                    className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                    onChange={(event) => updateForm("chatModel", event.target.value)}
                    required
                    value={form.chatModel}
                  />
                </label>
              </div>

              {realtimeConfigVisible && form.realtimeEnabled ? (
                <>
                  <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                    <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                      Realtime Base URL
                      <input
                        className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                        onChange={(event) => updateForm("realtimeBaseUrl", event.target.value)}
                        required
                        value={form.realtimeBaseUrl}
                      />
                    </label>
                    <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                      Realtime 模型
                      <input
                        className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                        onChange={(event) => updateForm("realtimeModel", event.target.value)}
                        required
                        value={form.realtimeModel}
                      />
                    </label>
                  </div>

                  <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                    默认音色
                    <input
                      className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                      onChange={(event) => updateForm("realtimeVoice", event.target.value)}
                      required
                      value={form.realtimeVoice}
                    />
                  </label>
                </>
              ) : null}

              {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{message}</div>}
              {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>}
            </div>

            <div className="sticky bottom-0 flex flex-wrap gap-3 border-t border-slate-100 bg-white/95 px-5 py-4 backdrop-blur">
              <button
                className="h-11 rounded-2xl bg-emerald-700 px-5 text-sm font-black text-white hover:bg-emerald-800 disabled:opacity-60"
                disabled={saving || clearing}
                type="submit"
              >
                {saving ? "保存中..." : "保存配置"}
              </button>
              <button
                className="h-11 rounded-2xl bg-slate-100 px-5 text-sm font-black text-slate-700 hover:bg-slate-200 disabled:opacity-60"
                disabled={saving || clearing || config?.keySource !== "user"}
                onClick={() => void clearApiKey()}
                type="button"
              >
                {clearing ? "清除中..." : "清除用户密钥"}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

