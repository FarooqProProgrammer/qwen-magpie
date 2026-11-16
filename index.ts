import { handleOpenAICompatFetch } from "./src/bridge.ts"
import { readChromeQwenSession } from "./src/chrome-cookies.ts"
import { authFromCookiePaste } from "./src/session.ts"
import { DEFAULT_MODELS, fetchQwenModels, validateQwenSession, type QwenAuth } from "./src/qwen.ts"

const PROVIDER = "qwen-web"

type PluginAuth = {
  type?: string
  key?: string
  access?: string
  metadata?: { cookies?: string; email?: string; profile?: string }
  accountId?: string
  cookies?: string
}

function authToQwen(auth: PluginAuth | undefined): QwenAuth | null {
  const token = auth?.access || auth?.key
  if (!token) return null
  const cookieHeader =
    auth?.cookies ||
    auth?.metadata?.cookies ||
    `token=${token}`
  return { token, cookieHeader }
}

async function loadFreshSession(saved?: PluginAuth): Promise<QwenAuth> {
  try {
    const live = await readChromeQwenSession("Default")
    return { token: live.token, cookieHeader: live.cookieHeader }
  } catch (e) {
    const fallback = authToQwen(saved)
    if (fallback) return fallback
    throw e
  }
}

export const QwenWebPlugin = async () => ({
  config: async (cfg: { provider?: Record<string, unknown> }) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Qwen Web",
      npm: "@ai-sdk/openai-compatible",
      api: "http://qwen-web.local/v1",
      models: DEFAULT_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "oauth",
        label: "Chrome Default (chat.qwen.ai)",
        async authorize() {
          return {
            url: "https://chat.qwen.ai",
            instructions:
              "Log into chat.qwen.ai in Chrome (Default profile), then fully quit Chrome (tray too) so the cookie DB unlocks. Magpie reads the session automatically.",
            method: "auto" as const,
            async callback() {
              try {
                const session = await readChromeQwenSession("Default")
                const check = await validateQwenSession({
                  token: session.token,
                  cookieHeader: session.cookieHeader,
                })
                if (!check.ok) {
                  return { type: "failed" as const, error: check.error.slice(0, 500) }
                }
                return {
                  type: "success" as const,
                  access: session.token,
                  refresh: session.token,
                  expires: Date.now() + 30 * 24 * 3600 * 1000,
                  accountId: session.email || "chrome-default",
                  cookies: session.cookieHeader,
                  metadata: {
                    cookies: session.cookieHeader,
                    email: session.email,
                    profile: session.profilePath,
                  },
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                const friendly = /lock|being used by another process|EBUSY|VSS/i.test(msg)
                  ? "Chrome is locking Cookies. Quit Chrome completely, then Try again — or Cancel and choose “Paste chat.qwen.ai Cookie header”."
                  : msg
                return {
                  type: "failed" as const,
                  error: friendly.slice(0, 500),
                }
              }
            },
          }
        },
      },
      {
        // Magpie only passes the paste into authorize when `prompts` are set.
        // Without prompts, inputs is undefined and the key field never reaches us.
        type: "api",
        label: "Paste Qwen cookies",
        prompts: [
          {
            type: "text",
            key: "cookies",
            message: "Cookie Editor JSON or Cookie header (needs token or refresh_token)",
            placeholder: '[{"name":"refresh_token","value":"eyJ…"}, …]',
          },
        ],
        async authorize(inputs: { cookies?: string; key?: string } | undefined) {
          const raw = String(inputs?.cookies || inputs?.key || "").trim()
          if (!raw) {
            return {
              type: "failed" as const,
              error: "Paste was empty. Paste the full Cookie Editor JSON array, then Sign in.",
            }
          }
          try {
            const session = await authFromCookiePaste(raw)
            const check = await validateQwenSession(session)
            if (!check.ok) return { type: "failed" as const, error: check.error.slice(0, 500) }
            return {
              type: "success" as const,
              key: session.token,
              metadata: { cookies: session.cookieHeader, email: session.email },
              accountId: session.email || "pasted-cookie",
            }
          } catch (e) {
            return {
              type: "failed" as const,
              error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
            }
          }
        },
      },
    ],

    async loader(getAuth: () => Promise<PluginAuth | undefined>) {
      const saved = await getAuth()
      if (!saved) return {}
      return {
        baseURL: "http://qwen-web.local/v1",
        apiKey: "qwen-web",
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const qwen = await loadFreshSession(saved)
          return handleOpenAICompatFetch(qwen, input, init)
        },
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(
      provider: { models?: typeof DEFAULT_MODELS },
      { auth }: { auth?: PluginAuth } = {},
    ) {
      const qwen = authToQwen(auth)
      if (!qwen) return provider.models || DEFAULT_MODELS
      try {
        const live = await loadFreshSession(auth)
        return await fetchQwenModels(live)
      } catch {
        return provider.models || DEFAULT_MODELS
      }
    },
  },
})

export const _internal = {
  readChromeQwenSession,
  validateQwenSession,
  authFromCookiePaste,
  DEFAULT_MODELS,
  PROVIDER,
}
