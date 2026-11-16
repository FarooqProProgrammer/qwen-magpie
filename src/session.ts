import { randomUUID } from "node:crypto"
import { QWEN_ORIGIN, QWEN_UA, type QwenAuth } from "./qwen.ts"

export type CookieEditorItem = {
  name?: string
  value?: string
  domain?: string
}

/** Parse Cookie Editor JSON array, {cookies:[...]}, raw Cookie header, or bare JWT. */
export function parseCookieInput(raw: string): {
  jar: Map<string, string>
  cookieHeader: string
} {
  const trimmed = raw.trim()
  const jar = new Map<string, string>()

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as CookieEditorItem[] | { cookies?: CookieEditorItem[] }
    const list = Array.isArray(parsed) ? parsed : parsed.cookies
    if (!Array.isArray(list)) {
      throw new Error("JSON cookies must be an array (Cookie Editor export) or { cookies: [...] }.")
    }
    for (const item of list) {
      if (!item?.name || item.value == null) continue
      jar.set(String(item.name), String(item.value))
    }
  } else if (trimmed.startsWith("eyJ") && !trimmed.includes("=") && !trimmed.includes(";")) {
    jar.set("token", trimmed)
  } else {
    for (const part of trimmed.split(";")) {
      const idx = part.indexOf("=")
      if (idx <= 0) continue
      const name = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (name) jar.set(name, value)
    }
  }

  if (jar.size === 0) throw new Error("No cookies found in pasted input.")
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
  return { jar, cookieHeader }
}

function emailFromJwt(token: string): string | undefined {
  try {
    const payload = token.split(".")[1]
    if (!payload) return
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string
      name?: string
      preferred_username?: string
      id?: string
    }
    return json.email || json.preferred_username || json.name || json.id
  } catch {
    return
  }
}

/** If token cookie is missing, mint one via GET /api/v1/auths/ using refresh_token jar. */
export async function resolveTokenFromCookies(cookieHeader: string, jar: Map<string, string>): Promise<{
  token: string
  cookieHeader: string
  email?: string
}> {
  let token = jar.get("token") || ""
  let header = cookieHeader

  if (!token) {
    const res = await fetch(`${QWEN_ORIGIN}/api/v1/auths/`, {
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json; charset=UTF-8",
        Cookie: cookieHeader,
        "User-Agent": QWEN_UA,
        source: "web",
        Referer: `${QWEN_ORIGIN}/`,
        Origin: QWEN_ORIGIN,
        "x-request-id": randomUUID(),
      },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `No token cookie and /api/v1/auths/ failed (${res.status}). Export must include token or a valid refresh_token. ${text.slice(0, 120)}`,
      )
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error("Qwen /api/v1/auths/ returned non-JSON (WAF or expired session). Re-export cookies from chat.qwen.ai.")
    }
    const nested = data.data as { token?: string } | undefined
    token = String(data.token || data.access_token || nested?.token || "")
    if (!token) {
      throw new Error("Qwen /api/v1/auths/ returned no token. Re-login on chat.qwen.ai and export cookies again.")
    }
    jar.set("token", token)
    header = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  return { token, cookieHeader: header, email: emailFromJwt(token) }
}

export async function authFromCookiePaste(raw: string): Promise<QwenAuth & { email?: string }> {
  const { jar, cookieHeader } = parseCookieInput(raw)
  if (!jar.has("token") && !jar.has("refresh_token")) {
    throw new Error("Paste needs a token and/or refresh_token cookie (Cookie Editor JSON or Cookie header).")
  }
  const resolved = await resolveTokenFromCookies(cookieHeader, jar)
  return {
    token: resolved.token,
    cookieHeader: resolved.cookieHeader,
    email: resolved.email,
  }
}
