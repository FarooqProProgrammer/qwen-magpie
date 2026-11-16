import { randomUUID } from "node:crypto"
import {
  buildQwenCompletionBody,
  createQwenChat,
  postQwenCompletions,
  type OpenAIMessage,
  type QwenAuth,
} from "./qwen.ts"

function openaiError(status: number, message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code: status === 400 ? "unsupported" : undefined } },
    { status },
  )
}

function extractDelta(q: Record<string, unknown>): { content: string; reasoning: string; done: boolean } {
  let content = ""
  let reasoning = ""
  let done = false
  const choices = q.choices as Array<Record<string, unknown>> | undefined
  if (Array.isArray(choices) && choices[0]) {
    const choice = choices[0]
    const delta = (choice.delta || choice.message || {}) as Record<string, unknown>
    const phase = String(delta.phase || "")
    if (phase === "think" || phase === "thinking" || phase === "thinking_summary") {
      reasoning = String(delta.content || delta.reasoning_content || delta.reasoning || "")
    } else if (phase === "answer" || !phase) {
      content = String(delta.content || "")
    } else {
      content = String(delta.content || "")
    }
    if (delta.reasoning_content) reasoning = String(delta.reasoning_content)
    done = choice.finish_reason === "stop" || delta.status === "finished"
  } else if (typeof q.content === "string") {
    content = q.content
  }
  return { content, reasoning, done }
}

async function pipeQwenSseToOpenAI(
  upstream: Response,
  model: string,
  wantStream: boolean,
): Promise<Response> {
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    return openaiError(upstream.status || 502, text.slice(0, 400) || `Qwen upstream ${upstream.status}`)
  }

  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  if (!wantStream) {
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let content = ""
    let reasoning = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() || ""
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.replace(/^data:\s?/, "")
        if (!data || data === "[DONE]") continue
        try {
          const q = JSON.parse(data) as Record<string, unknown>
          const d = extractDelta(q)
          content += d.content
          reasoning += d.reasoning
        } catch {
          /* ignore partial */
        }
      }
    }
    const message: Record<string, string> = { role: "assistant", content }
    if (reasoning) message.reasoning_content = reasoning
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
    })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  ;(async () => {
    const write = async (obj: unknown) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
    }
    try {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      let sentRole = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split(/\n\n/)
        buf = chunks.pop() || ""
        for (const block of chunks) {
          for (const line of block.split("\n")) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const data = trimmed.replace(/^data:\s?/, "")
            if (!data || data === "[DONE]") continue
            let q: Record<string, unknown>
            try {
              q = JSON.parse(data)
            } catch {
              continue
            }
            if (q.success === false) {
              const details =
                (q.data as { details?: string; code?: string } | undefined)?.details ||
                (q.data as { code?: string } | undefined)?.code ||
                "Qwen error"
              await write({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: `Error: ${details}` }, finish_reason: "stop" }],
              })
              continue
            }
            const d = extractDelta(q)
            if (!sentRole && (d.content || d.reasoning)) {
              sentRole = true
              await write({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              })
            }
            const delta: Record<string, string> = {}
            if (d.reasoning) delta.reasoning_content = d.reasoning
            if (d.content) delta.content = d.content
            if (Object.keys(delta).length) {
              await write({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta, finish_reason: null }],
              })
            }
            if (d.done) {
              await write({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })
            }
          }
        }
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: `Error: ${msg}` }, finish_reason: "stop" }],
            })}\n\n`,
          ),
        )
        await writer.write(encoder.encode("data: [DONE]\n\n"))
      } catch {
        /* closed */
      }
    } finally {
      try {
        await writer.close()
      } catch {
        /* closed */
      }
    }
  })()

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}

export async function handleOpenAICompatFetch(
  auth: QwenAuth,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method || "GET").toUpperCase()

  if (method === "GET" && /\/models\/?(\?|$)/.test(url)) {
    // Magpie usually uses provider.models; still answer if asked
    return Response.json({ object: "list", data: [] })
  }

  if (method === "POST" && /chat\/completions/.test(url)) {
    const raw = init?.body ? String(init.body) : "{}"
    let body: {
      model?: string
      messages?: OpenAIMessage[]
      stream?: boolean
      tools?: unknown
      functions?: unknown
    }
    try {
      body = JSON.parse(raw)
    } catch {
      return openaiError(400, "Invalid JSON body")
    }

    if (body.tools || body.functions) {
      return openaiError(
        400,
        "Tool calling is not supported on Qwen web chat. Use DashScope/API or Qwen Code OAuth for tools.",
      )
    }

    const wantStream = body.stream !== false
    const chatId = await createQwenChat(auth, (body.model || "qwen3.7-plus").replace(/^qwen-web\//, ""))
    const qwenBody = buildQwenCompletionBody(chatId, body)
    const upstream = await postQwenCompletions(auth, qwenBody, init?.signal ?? undefined)
    return pipeQwenSseToOpenAI(upstream, qwenBody._resolvedModel, wantStream)
  }

  // Pass-through would hit a fake baseURL — reject unknown paths clearly
  return openaiError(404, `qwen-web plugin does not handle ${method} ${url}`)
}
