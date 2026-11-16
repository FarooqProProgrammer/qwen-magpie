# opencode-qwen-web

Magpie / OpenCode plugin that uses your **Chrome Default** `chat.qwen.ai` login (no DashScope key).

## Install (Magpie)

1. Log into [chat.qwen.ai](https://chat.qwen.ai) in **Chrome → Default** profile.
2. Fully quit Chrome (including tray) — Windows locks `Cookies` while Chrome is running. Magpie may also try a Volume Shadow Copy while Chrome is open (sometimes needs admin).
3. Add the plugin folder:

If Chrome stays open / sign-in fails: Cancel → login again → **Paste chat.qwen.ai Cookie header** (DevTools → Network → any `chat.qwen.ai` request → Cookie).

```bash
magpie plugin add C:\Users\Farooq\Documents\product\qwen-web
magpie plugin login qwen-web
magpie provider test qwen-web
```

Models appear as `qwen-web/<model>` (for example `qwen-web/qwen3.7-plus`).

## Notes

- Web chat does **not** support OpenAI tool calling; requests with `tools` return **400**.
- Prefer closing Chrome before login/requests so the cookie DB can be copied.
- Unofficial personal use; Qwen may change the web API at any time.

## Inspired by

- [PruhaNLP/web-to-api](https://github.com/PruhaNLP/web-to-api) (session → local OpenAI idea)
- [ckcoding/QwenChat2Api](https://github.com/ckcoding/QwenChat2Api) / [Godde3s/qwen-free-api](https://github.com/Godde3s/qwen-free-api) (v2 chat HTTP + SSE)
