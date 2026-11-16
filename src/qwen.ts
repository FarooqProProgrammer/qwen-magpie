import { randomUUID } from "node:crypto"

export const QWEN_ORIGIN = "https://chat.qwen.ai"
export const QWEN_VERSION = "0.2.91"
export const QWEN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export const DEFAULT_MODELS: Record<
  string,
  { name: string; limit: { context: number; output: number }; tool_call: boolean }
> = {
  "qwen3.7-plus": {
    name: "Qwen3.7 Plus",
    limit: { context: 128000, output: 16000 },
    tool_call: false,
  },
  "qwen3.7-max": {
    name: "Qwen3.7 Max",
    limit: { context: 128000, output: 16000 },
    tool_call: false,
  },
  "qwen3.6-plus": {
    name: "Qwen3.6 Plus",
    limit: { context: 128000, output: 16000 },
    tool_call: false,
  },
  "qwen3-coder-plus": {
    name: "Qwen3 Coder Plus",
    limit: { context: 128000, output: 16000 },
    tool_call: false,
  },
}

export type QwenAuth = {
  token: string
  cookieHeader: string
}

function qwenHeaders(auth: QwenAuth, referer = `${QWEN_ORIGIN}/`): HeadersInit {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Origin: QWEN_ORIGIN,
    Referer: referer,
    source: "web",
    version: QWEN_VERSION,
    "User-Agent": QWEN_UA,
    "Accept-Language": "en-US,en;q=0.9",
    "x-request-id": randomUUID(),
    "x-accel-buffering": "no",
    Authorization: `Bearer ${auth.token}`,
    Cookie: auth.cookieHeader.includes("token=")
      ? auth.cookieHeader
      : `token=${auth.token}; ${auth.cookieHeader}`,
  }
}

function isHtmlWaf(status: number, text: string): boolean {
  if (status === 401 || status === 403) return false
  const t = text.slice(0, 200).toLowerCase()
  return t.includes("<!doctype") || t.includes("<html") || t.includes("rgv587")
}

export async function validateQwenSession(auth: QwenAuth): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${QWEN_ORIGIN}/api/models`, {
      headers: qwenHeaders(auth),
    })
    const text = await res.text()
    if (isHtmlWaf(res.status, text)) {
      return { ok: false, error: "Qwen WAF blocked the request. Close Chrome and retry, or refresh the chat.qwen.ai login." }
    }
    if (!res.ok) return { ok: false, error: `Qwen /api/models returned ${res.status}` }
    JSON.parse(text)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchQwenModels(auth: QwenAuth): Promise<typeof DEFAULT_MODELS> {
  try {
    const res = await fetch(`${QWEN_ORIGIN}/api/models`, { headers: qwenHeaders(auth) })
    const text = await res.text()
    if (!res.ok || isHtmlWaf(res.status, text)) return DEFAULT_MODELS
    const json = JSON.parse(text) as {
      data?: Array<{ id?: string; name?: string }>
    }
    if (!Array.isArray(json.data) || json.data.length === 0) return DEFAULT_MODELS
    const base = DEFAULT_MODELS["qwen3.7-plus"]
    const out: typeof DEFAULT_MODELS = {}
    for (const m of json.data) {
      if (!m.id) continue
      out[m.id] = {
        name: m.name || m.id,
        limit: base.limit,
        tool_call: false,
      }
    }
    return Object.keys(out).length ? out : DEFAULT_MODELS
  } catch {
    return DEFAULT_MODELS
  }
}

export async function createQwenChat(auth: QwenAuth, model: string, chatType = "t2t"): Promise<string> {
  const res = await fetch(`${QWEN_ORIGIN}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenHeaders(auth, `${QWEN_ORIGIN}/c/new-chat`),
    body: JSON.stringify({
      title: "New Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: chatType,
      timestamp: Date.now(),
    }),
  })
  const text = await res.text()
  if (isHtmlWaf(res.status, text)) {
    throw Object.assign(new Error("Qwen WAF blocked chats/new"), { status: 401, signIn: "expired" })
  }
  if (!res.ok) throw Object.assign(new Error(`chats/new failed: ${res.status} ${text.slice(0, 200)}`), { status: res.status })
  const json = JSON.parse(text) as { success?: boolean; data?: { id?: string } }
  const id = json.data?.id
  if (!id) throw new Error("chats/new returned no chat id")
  return id
}

export type OpenAIMessage = {
  role: string
  content: string | Array<{ type?: string; text?: string; content?: string }>
}

function flattenContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => (typeof p === "string" ? p : p.text || p.content || ""))
    .filter(Boolean)
    .join("\n")
}

function normalizeModel(model: string): { model: string; thinking: boolean } {
  const thinking = model.includes("-thinking") || model.includes("reasoner")
  const cleaned = model
    .replace(/^qwen-web\//, "")
    .replace(/-thinking$/, "")
    .replace(/-search$/, "")
  return { model: cleaned || "qwen3.7-plus", thinking }
}

export function buildQwenCompletionBody(
  chatId: string,
  openAI: { model?: string; messages?: OpenAIMessage[]; stream?: boolean },
) {
  const { model, thinking } = normalizeModel(openAI.model || "qwen3.7-plus")
  const messages = openAI.messages || []
  const ts = Date.now()
  const feature = {
    thinking_enabled: thinking,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: thinking,
    thinking_mode: thinking ? "Auto" : "Disabled",
    thinking_format: "summary",
    auto_search: false,
    code_interpreter: false,
    plugins_enabled: false,
    function_calling: false,
    enable_tools: false,
    enable_function_call: false,
    tool_choice: "none",
  }

  const qwenMessages = messages.map((msg) => {
    const fid = randomUUID()
    return {
      fid,
      parentId: null,
      childrenIds: [] as string[],
      role: msg.role === "system" ? "user" : msg.role,
      content:
        msg.role === "system"
          ? `[system]\n${flattenContent(msg.content)}`
          : flattenContent(msg.content),
      user_action: msg.role === "assistant" ? undefined : "chat",
      files: [] as unknown[],
      timestamp: ts,
      models: [model],
      chat_type: "t2t",
      feature_config: feature,
      extra: { meta: { subChatType: "t2t" } },
      sub_chat_type: "t2t",
      parent_id: null,
    }
  })

  return {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: qwenMessages,
    timestamp: ts,
    _resolvedModel: model,
  }
}

export async function postQwenCompletions(
  auth: QwenAuth,
  body: ReturnType<typeof buildQwenCompletionBody>,
  signal?: AbortSignal,
): Promise<Response> {
  const { _resolvedModel: _m, ...payload } = body
  const url = `${QWEN_ORIGIN}/api/v2/chat/completions?chat_id=${encodeURIComponent(body.chat_id)}`
  const res = await fetch(url, {
    method: "POST",
    headers: qwenHeaders(auth, `${QWEN_ORIGIN}/c/${body.chat_id}`),
    body: JSON.stringify(payload),
    signal,
  })
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("text/html")) {
    const text = await res.text()
    throw Object.assign(new Error("Qwen WAF returned HTML (session expired or blocked)"), {
      status: 401,
      signIn: "expired",
      body: text.slice(0, 300),
    })
  }
  return res
}
