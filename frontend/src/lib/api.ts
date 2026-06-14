export interface AuthUser {
  id: string;
  username: string;
  createdAt: number;
}

export interface AuthSession {
  accessToken: string;
  tokenType: string;
  user: AuthUser;
}

export interface PersistedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  latestCost: Record<string, unknown>;
}

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
}

export interface ModelConfig {
  baseUrl: string;
  chatModel: string;
  realtimeEnabled: boolean;
  realtimeBaseUrl: string;
  realtimeModel: string;
  realtimeVoice: string;
  keyConfigured: boolean;
  keyPreview: string;
  keySource: "user" | "environment" | "missing";
  updatedAt: number | null;
}

export interface ModelConfigUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl: string;
  chatModel: string;
  realtimeEnabled: boolean;
  realtimeBaseUrl: string;
  realtimeModel: string;
  realtimeVoice: string;
}

export interface UsageTotals {
  eventCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  audioMs: number;
  speechMs: number;
  audioChunks: number;
  ttsChars: number;
  ttsAudioMs: number;
  imageCount: number;
  estimatedUnits: number;
}

export interface UsageBucket extends UsageTotals {
  id?: string;
  title?: string;
  modality?: string;
  lastUsedAt?: number;
}

export interface UsageEvent extends UsageTotals {
  provider: string;
  model: string;
  modality: string;
  metricType: string;
  createdAt: number;
}

export interface UsageStats {
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  days: number;
  totals: UsageTotals;
  modalities: UsageBucket[];
  conversations: UsageBucket[];
  recentEvents: UsageEvent[];
}

const AUTH_STORAGE_KEY = "ai-vision-auth";

async function requestJson<T>(baseUrl: string, path: string, options: RequestInit = {}, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail ?? "请求失败");
  }
  return body as T;
}

export function loadStoredAuth(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

export function storeAuth(session: AuthSession | null) {
  if (!session) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export async function registerUser(baseUrl: string, username: string, password: string) {
  return requestJson<AuthSession>(baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function loginUser(baseUrl: string, username: string, password: string) {
  return requestJson<AuthSession>(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchCurrentUser(baseUrl: string, token: string) {
  return requestJson<AuthUser>(baseUrl, "/api/me", {}, token);
}

export async function fetchConversations(baseUrl: string, token: string) {
  return requestJson<PersistedConversation[]>(baseUrl, "/api/conversations", {}, token);
}

export async function createConversation(baseUrl: string, token: string, title = "新会话") {
  return requestJson<PersistedConversation>(
    baseUrl,
    "/api/conversations",
    {
      method: "POST",
      body: JSON.stringify({ title }),
    },
    token,
  );
}

export async function fetchConversation(baseUrl: string, token: string, conversationId: string) {
  return requestJson<PersistedConversation>(baseUrl, `/api/conversations/${conversationId}`, {}, token);
}

export async function renameConversation(baseUrl: string, token: string, conversationId: string, title: string) {
  return requestJson<PersistedConversation>(
    baseUrl,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title }),
    },
    token,
  );
}

export async function deleteConversation(baseUrl: string, token: string, conversationId: string) {
  await requestJson<unknown>(
    baseUrl,
    `/api/conversations/${conversationId}`,
    {
      method: "DELETE",
    },
    token,
  );
}

export async function fetchConversationMessages(baseUrl: string, token: string, conversationId: string) {
  return requestJson<PersistedMessage[]>(baseUrl, `/api/conversations/${conversationId}/messages`, {}, token);
}

export async function fetchModelConfig(baseUrl: string, token: string) {
  return requestJson<ModelConfig>(baseUrl, "/api/model-config", {}, token);
}

export async function updateModelConfig(baseUrl: string, token: string, payload: ModelConfigUpdate) {
  return requestJson<ModelConfig>(
    baseUrl,
    "/api/model-config",
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    token,
  );
}

export async function fetchUsageStats(baseUrl: string, token: string, days = 7) {
  return requestJson<UsageStats>(baseUrl, `/api/usage/stats?days=${days}`, {}, token);
}
