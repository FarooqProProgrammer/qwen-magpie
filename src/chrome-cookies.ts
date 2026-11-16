import { createDecipheriv } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const QWEN_HOST_LIKE = "%qwen.ai%"

export type QwenChromeSession = {
  token: string
  cookieHeader: string
  email?: string
  profilePath: string
}

function chromeUserDataRoot(): string {
  const local = process.env.LOCALAPPDATA
  if (!local) throw new Error("LOCALAPPDATA is not set (Windows only for Chrome Default).")
  return join(local, "Google", "Chrome", "User Data")
}

function cookieDbPath(profileDir: string): string {
  const network = join(profileDir, "Network", "Cookies")
  if (existsSync(network)) return network
  const legacy = join(profileDir, "Cookies")
  if (existsSync(legacy)) return legacy
  throw new Error(`Chrome Cookies DB not found under ${profileDir}`)
}

async function runPowerShell(script: string, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const code = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  return { code, stderr }
}

/** Copy locked Cookies via Volume Shadow Copy (works while Chrome is open). */
async function copyFileViaVss(src: string, dest: string): Promise<boolean> {
  const script = `
$ErrorActionPreference = 'Stop'
$src = $env:QWEN_COPY_SRC
$dst = $env:QWEN_COPY_DST
$drive = ([IO.Path]::GetPathRoot($src)).TrimEnd('\\') + '\\'
$class = Get-CimClass -ClassName Win32_ShadowCopy -Namespace root\\cimv2
$result = Invoke-CimMethod -CimClass $class -MethodName Create -Arguments @{ Volume = $drive; Context = 'ClientAccessible' }
if ($result.ReturnValue -ne 0) { throw "VSS Create failed: $($result.ReturnValue)" }
$id = $result.ShadowID
$shadow = Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $id }
if (-not $shadow) { throw 'VSS shadow not found' }
try {
  $device = $shadow.DeviceObject.TrimEnd('\\')
  $rel = $src.Substring(3) # strip C:\\
  $shadowPath = $device + '\\' + $rel
  Copy-Item -LiteralPath $shadowPath -Destination $dst -Force
} finally {
  $shadow | Remove-CimInstance
}
`
  const { code } = await runPowerShell(script, { QWEN_COPY_SRC: src, QWEN_COPY_DST: dest })
  return code === 0 && existsSync(dest)
}

/** Copy even when Chrome holds the Cookies DB. */
async function copyFileShared(src: string, dest: string): Promise<void> {
  try {
    copyFileSync(src, dest)
    return
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== "EBUSY" && err.code !== "EPERM") throw e
  }

  // 1) Share-mode open (works if Chrome allows sharing)
  const share = await runPowerShell(
    `
$ErrorActionPreference = 'Stop'
$src = $env:QWEN_COPY_SRC
$dst = $env:QWEN_COPY_DST
$in = [IO.File]::Open($src, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  $out = [IO.File]::Create($dst)
  try { $in.CopyTo($out) } finally { $out.Dispose() }
} finally { $in.Dispose() }
`,
    { QWEN_COPY_SRC: src, QWEN_COPY_DST: dest },
  )
  if (share.code === 0 && existsSync(dest)) return

  // 2) Volume Shadow Copy (works while Chrome is open; may need admin)
  if (await copyFileViaVss(src, dest)) return

  throw new Error(
    "Chrome is locking Cookies. Fully quit Chrome and click Try again — or Cancel and use “Paste chat.qwen.ai Cookie header”.",
  )
}

async function dpapiUnprotect(encrypted: Buffer): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "qwen-web-dpapi-"))
  const inn = join(dir, "in.bin")
  const out = join(dir, "out.bin")
  writeFileSync(inn, encrypted)
  try {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes($env:QWEN_DPAPI_IN)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($env:QWEN_DPAPI_OUT, $plain)
`
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: { ...process.env, QWEN_DPAPI_IN: inn, QWEN_DPAPI_OUT: out },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const code = await proc.exited
    if (code !== 0 || !existsSync(out)) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`DPAPI decrypt failed: ${err || `exit ${code}`}`)
    }
    return readFileSync(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function chromeEncryptionKey(userDataRoot: string): Promise<Buffer> {
  const localStatePath = join(userDataRoot, "Local State")
  if (!existsSync(localStatePath)) throw new Error(`Chrome Local State missing: ${localStatePath}`)
  const localState = JSON.parse(readFileSync(localStatePath, "utf8")) as {
    os_crypt?: { encrypted_key?: string }
  }
  const b64 = localState.os_crypt?.encrypted_key
  if (!b64) throw new Error("Chrome os_crypt.encrypted_key missing in Local State")
  const raw = Buffer.from(b64, "base64")
  // Prefix "DPAPI"
  if (raw.subarray(0, 5).toString("utf8") !== "DPAPI") {
    throw new Error("Unexpected Chrome key prefix (expected DPAPI)")
  }
  return dpapiUnprotect(raw.subarray(5))
}

function decryptCookieValue(encryptedValue: Buffer, key: Buffer): string {
  if (!encryptedValue?.length) return ""
  const prefix = encryptedValue.subarray(0, 3).toString("utf8")
  if (prefix === "v10" || prefix === "v11") {
    const iv = encryptedValue.subarray(3, 15)
    const tag = encryptedValue.subarray(encryptedValue.length - 16)
    const data = encryptedValue.subarray(15, encryptedValue.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  }
  if (prefix === "v20") {
    throw new Error(
      "Chrome app-bound cookie encryption (v20) is not supported. Use a Chrome profile with DPAPI v10 cookies, or export the token cookie manually.",
    )
  }
  // Older DPAPI-only blobs
  throw new Error(`Unsupported cookie encryption prefix: ${prefix || "(empty)"}`)
}

function emailFromJwt(token: string): string | undefined {
  try {
    const payload = token.split(".")[1]
    if (!payload) return
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string
      name?: string
      preferred_username?: string
    }
    return json.email || json.preferred_username || json.name
  } catch {
    return
  }
}

/** Read chat.qwen.ai cookies from Chrome Default. Prefer closing Chrome first. */
export async function readChromeQwenSession(
  profileName = "Default",
): Promise<QwenChromeSession> {
  const userDataRoot = chromeUserDataRoot()
  const profilePath = join(userDataRoot, profileName)
  if (!existsSync(profilePath)) {
    throw new Error(`Chrome profile not found: ${profilePath}`)
  }

  const key = await chromeEncryptionKey(userDataRoot)
  const srcDb = cookieDbPath(profilePath)
  const dir = mkdtempSync(join(tmpdir(), "qwen-web-cookies-"))
  const copy = join(dir, "Cookies")
  try {
    await copyFileShared(srcDb, copy)
    const wal = srcDb + "-wal"
    const shm = srcDb + "-shm"
    if (existsSync(wal)) {
      try {
        await copyFileShared(wal, copy + "-wal")
      } catch {
        /* optional */
      }
    }
    if (existsSync(shm)) {
      try {
        await copyFileShared(shm, copy + "-shm")
      } catch {
        /* optional */
      }
    }

    const db = new Database(copy, { readonly: true })
    try {
      const rows = db
        .query(
          `SELECT host_key, name, encrypted_value, value
           FROM cookies
           WHERE host_key LIKE ?
           ORDER BY LENGTH(host_key) DESC`,
        )
        .all(QWEN_HOST_LIKE) as Array<{
        host_key: string
        name: string
        encrypted_value: Uint8Array | Buffer | null
        value: string | null
      }>

      const jar = new Map<string, string>()
      for (const row of rows) {
        let val = row.value || ""
        if (!val && row.encrypted_value) {
          const buf = Buffer.from(row.encrypted_value)
          try {
            val = decryptCookieValue(buf, key)
          } catch (e) {
            // skip undecryptable cookies; token is required
            if (row.name === "token") throw e
            continue
          }
        }
        if (val) jar.set(row.name, val)
      }

      const token = jar.get("token")
      if (!token) {
        throw new Error(
          "No token cookie for *.qwen.ai in Chrome Default. Log into https://chat.qwen.ai in Chrome, then close Chrome and try again.",
        )
      }

      // Prefer a full jar; always ensure token is present
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
      return {
        token,
        cookieHeader,
        email: emailFromJwt(token),
        profilePath,
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
