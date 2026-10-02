import { app, safeStorage } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

// Secrets (refresh tokens, API keys) are encrypted with Windows DPAPI for the signed-in Windows
// user, called directly through PowerShell. This does not depend on Chromium's key in "Local
// State", which a session started straight after an install could replace with one that was never
// saved, leaving its secrets unreadable afterwards. They are kept out of SQLite and out of the repo,
// and decrypted values are cached in memory for the session.
//
// Older secrets written with Electron's safeStorage (*.bin) are still read, and moved to DPAPI
// (*.dpapi) the first time they are read successfully.

const ENTROPY = 'command-center'
const cache = new Map<string, string>()

function secretsDir(): string {
  const dir = join(app.getPath('userData'), 'secrets')
  mkdirSync(dir, { recursive: true })
  return dir
}

function baseName(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

const dpapiPath = (key: string): string => join(secretsDir(), `${baseName(key)}.dpapi`)
const legacyPath = (key: string): string => join(secretsDir(), `${baseName(key)}.bin`)

// ---------- DPAPI through PowerShell ----------

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Reads base64 lines on stdin and writes one base64 result per line (empty line on failure). */
function dpapiScript(protect: boolean): string {
  const op = protect ? 'Protect' : 'Unprotect'
  return [
    'Add-Type -AssemblyName System.Security',
    `$e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    '$out = foreach ($line in [Console]::In.ReadToEnd() -split "`n") {',
    '  $l = $line.Trim(); if ($l -eq "") { continue }',
    '  try { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::' +
      op +
      "([Convert]::FromBase64String($l), $e, 'CurrentUser')) } catch { '' }",
    '}',
    '[Console]::Out.Write(($out -join "`n"))'
  ].join('\n')
}

function dpapiSync(protect: boolean, inputs: string[]): string[] {
  const output = execFileSync('powershell.exe', [...PS_ARGS, dpapiScript(protect)], {
    input: inputs.join('\n'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  return output.split('\n').map((s) => s.trim())
}

function protect(value: string): string {
  const [result] = dpapiSync(true, [Buffer.from(value, 'utf8').toString('base64')])
  if (!result) throw new Error('Windows could not encrypt the secret.')
  return result
}

function unprotect(blob: string): string | null {
  const [result] = dpapiSync(false, [blob.trim()])
  return result ? Buffer.from(result, 'base64').toString('utf8') : null
}

// ---------- Public API ----------

export function saveSecret(key: string, value: string): void {
  if (process.platform !== 'win32') return saveLegacy(key, value)
  const blob = protect(value)
  // Refuse to store anything that can't be read back.
  if (unprotect(blob) !== value) throw new Error('Could not verify the encrypted secret.')
  const path = dpapiPath(key)
  writeFileSync(`${path}.tmp`, blob, 'utf8')
  renameSync(`${path}.tmp`, path)
  rmSync(legacyPath(key), { force: true })
  cache.set(key, value)
}

/**
 * Returns the secret, or null if it is missing. A secret that can no longer be decrypted is set
 * aside (renamed to .unreadable) and treated as missing, so the caller falls back to asking the user
 * to reconnect or re-enter it instead of failing.
 */
export function readSecret(key: string): string | null {
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const warmed = warm.get(`${baseName(key)}.dpapi`)
  if (warmed !== undefined) {
    cache.set(key, warmed)
    return warmed
  }

  const path = dpapiPath(key)
  if (existsSync(path)) {
    const value = unprotect(readFileSync(path, 'utf8'))
    if (value !== null) {
      cache.set(key, value)
      return value
    }
    setAside(path, key)
    return null
  }

  // Older safeStorage secret: read it once, then move it to DPAPI.
  const legacy = readLegacy(key)
  if (legacy !== null && process.platform === 'win32') {
    try {
      saveSecret(key, legacy)
    } catch (err) {
      console.error('Moving a secret to DPAPI failed; keeping the old file.', err)
    }
  }
  if (legacy !== null) cache.set(key, legacy)
  return legacy
}

export function deleteSecret(key: string): void {
  cache.delete(key)
  rmSync(dpapiPath(key), { force: true })
  rmSync(legacyPath(key), { force: true })
}

/**
 * Decrypts every DPAPI secret in one PowerShell call and fills the cache, so the first sync after
 * startup doesn't pay one process launch per secret.
 */
export function warmSecretCache(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const files = readdirSync(secretsDir()).filter((f) => f.endsWith('.dpapi'))
  if (files.length === 0) return Promise.resolve()
  const blobs = files.map((f) => readFileSync(join(secretsDir(), f), 'utf8').trim())
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      [...PS_ARGS, dpapiScript(false)],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (!err) {
          const results = stdout.split('\n').map((s) => s.trim())
          files.forEach((f, i) => {
            if (results[i]) warm.set(f, Buffer.from(results[i], 'base64').toString('utf8'))
          })
        }
        resolve()
      }
    )
    child.stdin?.end(blobs.join('\n'))
  })
}

/** Decrypted values by file name; moved into `cache` on first lookup by key. */
const warm = new Map<string, string>()

function setAside(path: string, key: string): void {
  console.error(`Secret for ${key.split(':')[0]} could not be decrypted; setting it aside.`)
  renameSync(path, `${path}.unreadable`)
}

// ---------- Legacy safeStorage (pre-DPAPI) ----------

function saveLegacy(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable.')
  const path = legacyPath(key)
  writeFileSync(`${path}.tmp`, safeStorage.encryptString(value))
  renameSync(`${path}.tmp`, path)
  cache.set(key, value)
}

function readLegacy(key: string): string | null {
  const path = legacyPath(key)
  if (!existsSync(path)) return null
  try {
    return safeStorage.decryptString(readFileSync(path))
  } catch {
    setAside(path, key)
    return null
  }
}
