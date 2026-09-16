/**
 * Dependency-free V1 memory engine for the opencode-memory plugin.
 *
 * Semantically equivalent to the V2 reference (`v2/memory-core.mjs`). The V1
 * plugin entry (`index.ts`) only adapts this engine to the V1 plugin/zod
 * contract — all path resolution, containment, durability, retention, and
 * context logic lives here.
 *
 * Command evaluation is exposed at two levels:
 *   - `run(args, sessionID)`        → the bare public V1 string
 *   - `runCommand(args, sessionID)` → `{ text, outcome }`
 * where `text` is the exact V1 public string and `outcome` is the typed record
 * (`{ ok, type, code, content }`) used internally and by tests.
 */
import fs from "node:fs/promises"
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  LOCK_PREFIX,
  MAX_READ_BYTES,
  OWNER_FILE,
  TEMP_PREFIX,
  assertSafePath,
  atomicCreateFrom,
  atomicUpdate,
  claimDirectoryOwner,
  cleanupStaleArtifacts,
  containedPath,
  ensureManagedDir,
  exclusiveCreate,
  safeRead,
  safeRemove,
  safeRename,
} from "./memory-safe-fs.mjs"
import { ACCESS_FILE, readAccessLedgerSync, recordSessionAccess } from "./memory-access-ledger.mjs"
import {
  boundedDirectoryListing,
  buildMemoryContext,
  MAX_CONTEXT_LINES,
  mergedSessionEntries,
  recursiveEntries,
  stableCompare,
} from "./memory-context.mjs"

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const MAX_USER_MEMORY_LINES = MAX_CONTEXT_LINES
export const MAX_SCOPE_ENTRIES = 100
export const MAX_SCOPE_BYTES = 200_000
export const MAX_MEMORY_FILE_BYTES = 100_000
export const OUTCOME_SUCCESS = "success"
export const OUTCOME_ERROR = "error"
export const OUTCOME_CODES = Object.freeze({
  CREATED: "created", UPDATED: "updated", DELETED: "deleted", RENAMED: "renamed", LISTED: "listed", VIEWED: "viewed",
  INVALID_INPUT: "invalid_input", INVALID_PATH: "invalid_path", NOT_FOUND: "not_found", CONFLICT: "conflict", IO_ERROR: "io_error",
})

export function defaultConfigDir(env = process.env) {
  return env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
}

export const MEMORY_DESCRIPTION = `Manage a bounded persistent memory system with three scopes.

- \`/memories/\`: user notes shared across projects.
- \`/memories/session/\`: current-session notes. Individual entries expire after 14 days of inactivity.
- \`/memories/repo/\`: notes for the current project.

Keep entries concise and focused. Do not store passwords, tokens, API keys, or other secrets. Memory may be stale or incomplete, so verify important information before relying on it. Listings and injected context are intentionally bounded.
User memory is limited to 200 total lines; all scopes also have file-count and byte limits.

Commands:
- \`view\`: View a file or directory.
- \`create\`: Exclusively create a file; fails if it exists.
- \`str_replace\`: Replace one exact, unique, non-empty string.
- \`insert\`: Insert text at a zero-based line position.
- \`delete\`: Delete a file or non-scope-root directory.
- \`rename\`: Rename within one scope; scope roots cannot be renamed.`

/**
 * JSON-schema mirror of the V1 zod tool schema (`index.ts`), kept in step with
 * the V2 reference so the accepted input surface stays identical across
 * runtimes. The V1 plugin registers the zod version; this export documents and
 * test-asserts that surface.
 */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["view", "create", "str_replace", "insert", "delete", "rename"], description: "The operation to perform on the memory file system." },
    path: { type: "string", description: 'The absolute path inside /memories/, e.g. "/memories/notes.md".' },
    file_text: { type: "string", description: "Required for `create`. The file content." },
    old_str: { type: "string", description: "Required for `str_replace`; must be non-empty and occur exactly once." },
    new_str: { type: "string", description: "Replacement text, or an `insert` fallback when `insert_text` is absent." },
    insert_line: { type: "number", description: "Required for `insert`. Zero-based line position." },
    insert_text: { type: "string", description: "Text for `insert`; may be empty." },
    view_range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Optional [start_line, end_line], one-based and inclusive." },
    old_path: { type: "string", description: "Source path for `rename`." },
    new_path: { type: "string", description: "Destination path for `rename`." },
  },
  required: ["command"],
  additionalProperties: false,
}

function normalizedVirtualPath(value) {
  let result = value.startsWith("/") ? value : `/${value}`
  result = result.replace(/\/{2,}/g, "/")
  if (result.length > 1 && result.endsWith("/")) result = result.slice(0, -1)
  return result
}

const fold = (value) => value.toLocaleLowerCase("en-US")
const isReservedUserComponent = (value) => ["session", "repo"].includes(fold(value))

export function validatePath(value) {
  if (typeof value !== "string" || value.length === 0) return "Error: path is required"
  if (value.includes("\0") || value.includes("\\")) return "Error: Invalid path"
  const normalized = normalizedVirtualPath(value)
  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) return "Error: Path traversal is not allowed"
  if (segments[0] !== "memories") return "Error: All memory paths must start with /memories/"
  if (segments.slice(1).some((segment) => segment === OWNER_FILE || segment === ACCESS_FILE || segment.startsWith(TEMP_PREFIX) || segment.startsWith(LOCK_PREFIX))) return "Error: Invalid path"
  return undefined
}

/**
 * Fixed, non-leaking public text for structurally malformed arguments. The
 * runtime validator below is the authority: the V1 zod schema and the V2 JSON
 * schema only describe the surface, and both runtimes are driven directly by
 * tests, embedders, and native tool callers that bypass schema validation.
 */
export const INVALID_ARGUMENTS_TEXT = "Error: invalid arguments"
export const MEMORY_COMMANDS = Object.freeze(["view", "create", "str_replace", "insert", "delete", "rename"])

const STRING_ARGUMENTS = Object.freeze(["path", "file_text", "old_str", "new_str", "insert_text", "old_path", "new_path"])

function isPlainArguments(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFiniteInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
}

function invalidArgumentsFailure() {
  return failure("invalid_arguments", INVALID_ARGUMENTS_TEXT)
}

/**
 * Strict runtime argument validation, independent of any advertised schema.
 * Returns a fixed failure record for malformed arguments and `undefined` when
 * the shape is acceptable; per-command missing-field messages stay with the
 * command bodies below so their historical public text is unchanged. Unknown
 * *string* commands intentionally fall through to the historical
 * "Error: unknown command" contract.
 */
function validateArguments(args) {
  if (!isPlainArguments(args)) return invalidArgumentsFailure()
  const has = (key) => Object.prototype.hasOwnProperty.call(args, key)
  for (const key of STRING_ARGUMENTS) {
    if (has(key) && typeof args[key] !== "string") return invalidArgumentsFailure()
  }
  if (has("insert_line") && !isFiniteInteger(args.insert_line)) return invalidArgumentsFailure()
  if (has("view_range")) {
    const range = args.view_range
    if (!Array.isArray(range) || range.length !== 2 || !range.every(isFiniteInteger)) return invalidArgumentsFailure()
  }
  if (typeof args.command !== "string") return invalidArgumentsFailure()
  return undefined
}

function requireSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    const error = new Error("A non-empty session ID is required for session memory")
    error.code = "ESESSION"
    throw error
  }
  return sessionID
}

function fmtLine(number) {
  return String(number).padStart(6, " ")
}

const TRUNCATION_MARKER = `[truncated: showing at most the first ${MAX_READ_BYTES} bytes of this memory file]`

function formatFileContent(virtPath, content, range, truncated = false) {
  const lines = content.split("\n")
  const suffix = truncated ? `\n${TRUNCATION_MARKER}` : ""
  if (!range) return `Here's the content of ${virtPath} with line numbers:\n` + lines.map((line, i) => `${fmtLine(i + 1)}\t${line}`).join("\n") + suffix
  const [start, end] = range
  if (!Number.isInteger(start) || start < 1 || start > lines.length) return `Error: Invalid view_range: start line is out of range [1, ${lines.length}].`
  if (!Number.isInteger(end) || end < start || end > lines.length) return "Error: Invalid view_range: end line is out of range for the requested start and file length."
  return `Here's the content of ${virtPath} (lines ${start}-${end}) with line numbers:\n` + lines.slice(start - 1, end).map((line, i) => `${fmtLine(start + i)}\t${line}`).join("\n") + suffix
}

function makeSnippet(content, editLine, virtPath) {
  const lines = content.split("\n")
  const start = Math.max(0, editLine - 5)
  const end = Math.min(lines.length, editLine + 4)
  return `The memory file has been edited. Here's the result of running \`cat -n\` on a snippet of ${virtPath}:\n` + lines.slice(start, end).map((line, i) => `${fmtLine(start + i + 1)}\t${line}`).join("\n")
}

const success = (code, content, metadata) => ({ ok: true, type: OUTCOME_SUCCESS, code, content, ...(metadata ?? {}) })
const failure = (code, content) => ({ ok: false, type: OUTCOME_ERROR, code, content })

export function errorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "EIO"
  return /^[A-Z0-9_]{1,24}$/.test(code) ? code : "EIO"
}

function displayVirtualPath(value) {
  if (typeof value !== "string" || !value.startsWith("/memories")) return "/memories/"
  return value.slice(0, 512).replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function sanitizedFailure(error, virtPath = "/memories/") {
  const code = errorCode(error)
  const safePath = displayVirtualPath(virtPath)
  if (code === "ESESSION") return failure("invalid_session", "Error: A non-empty session ID is required for session memory")
  if (code === "ENOENT") return failure("not_found", `Error: path does not exist: ${safePath}`)
  if (code === "EFBIG") return failure("limit_exceeded", "Error: Memory file is too large to edit safely.")
  if (["EEXIST"].includes(code)) return failure("already_exists", `Error: path already exists: ${safePath}`)
  if (["ESTALE", "EBUSY"].includes(code)) return failure("conflict", `Error: memory changed during update or before mutation: ${safePath}`)
  if (["ELOOP", "EPERM", "ENOTDIR"].includes(code)) return failure("unsafe_path", `Error: symlink or unsafe memory path: ${safePath}`)
  return failure("io_error", `Error: memory operation failed: ${safePath}`)
}

export function createMemory(options = {}) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd())
  const userRoot = path.resolve(options.userRoot ?? path.join(defaultConfigDir(), "memories"))
  const repoRoot = path.resolve(projectDir, ".opencode", "memories")
  const sessionBase = path.join(userRoot, "session")
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const beforeCommit = options.beforeCommit
  const beforeMutation = options.beforeMutation
  // Injectable access-ledger seam: tests and embedders can substitute the
  // recorder (typically to force failures) without touching command logic.
  const writeAccessLedger = options.recordSessionAccess ?? recordSessionAccess
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const locks = new Map()
  const logCode = (code) => log(code)

  const sessionHash = (sessionID) => createHash("sha256").update(requireSessionID(sessionID)).digest("hex")
  const sessionRoot = (sessionID) => path.join(sessionBase, sessionHash(sessionID))
  const legacySessionRoot = (sessionID) => {
    const name = requireSessionID(sessionID).replace(/[^a-zA-Z0-9_.-]/g, "_")
    if (!name || name === "." || name === ".." || name.includes(path.sep) || /^[a-f0-9]{64}$/.test(name)) return undefined
    const candidate = path.resolve(sessionBase, name)
    if (path.dirname(candidate) !== path.resolve(sessionBase)) return undefined
    return candidate
  }
  const isSessionPath = (value) => {
    const p = normalizedVirtualPath(value)
    return p === "/memories/session" || p.startsWith("/memories/session/")
  }

  function resolvePath(virtPath, sessionID) {
    const error = validatePath(virtPath)
    if (error) throw new Error(error.replace(/^Error: /, ""))
    const normalized = normalizedVirtualPath(virtPath)
    if (normalized === "/memories/repo" || normalized.startsWith("/memories/repo/")) {
      const rel = normalized.slice("/memories/repo".length).replace(/^\//, "")
      return { real: containedPath(repoRoot, rel), root: repoRoot, rel, scope: "repo" }
    }
    if (normalized === "/memories/session" || normalized.startsWith("/memories/session/")) {
      const root = sessionRoot(sessionID)
      const rel = normalized.slice("/memories/session".length).replace(/^\//, "")
      return { real: containedPath(root, rel), root: userRoot, sessionDir: root, rel, scope: "session" }
    }
    const rel = normalized.slice("/memories".length).replace(/^\//, "")
    const first = rel.split("/")[0]
    if (first && isReservedUserComponent(first)) {
      const reserved = new Error("Reserved memory namespace")
      reserved.code = "EPERM"
      throw reserved
    }
    const candidate = containedPath(userRoot, rel)
    const foldedCandidate = fold(path.resolve(candidate))
    const foldedSessionBase = fold(path.resolve(sessionBase))
    if (foldedCandidate === foldedSessionBase || foldedCandidate.startsWith(`${foldedSessionBase}${path.sep}`)) {
      const reserved = new Error("Reserved memory namespace")
      reserved.code = "EPERM"
      throw reserved
    }
    return { real: candidate, root: userRoot, rel, scope: "user" }
  }

  function legacyResolved(virtPath, sessionID) {
    const normalized = normalizedVirtualPath(virtPath)
    const root = legacySessionRoot(sessionID)
    if (!root) return undefined
    const rel = normalized.slice("/memories/session".length).replace(/^\//, "")
    return { real: containedPath(root, rel), root: userRoot, sessionDir: root, rel, scope: "session" }
  }

  async function ownedLegacyResolved(virtPath, sessionID) {
    const legacy = legacyResolved(virtPath, sessionID)
    if (!legacy || path.resolve(legacy.sessionDir) === path.resolve(sessionRoot(sessionID))) return undefined
    try {
      if (!await claimDirectoryOwner(userRoot, legacy.sessionDir, sessionHash(sessionID))) return undefined
      return legacy
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  async function sessionRoots(sessionID) {
    const primary = sessionRoot(sessionID)
    const legacy = await ownedLegacyResolved("/memories/session", sessionID)
    return [{ scopeRoot: userRoot, dir: primary }, ...(legacy ? [{ scopeRoot: userRoot, dir: legacy.sessionDir }] : [])]
  }

  /**
   * Best-effort access bookkeeping. Session freshness is an optimization only,
   * so a ledger failure before or after a read/mutation must never change the
   * command or context outcome. Errors are reduced to a sanitized code (never a
   * path, message, or stack) and swallowed.
   */
  async function markAccessed(real, root = userRoot) {
    const timestamp = now()
    try {
      const current = path.resolve(real)
      const base = path.resolve(sessionBase)
      if (current === base || !current.startsWith(`${base}${path.sep}`)) return
      const relative = path.relative(base, current)
      const first = relative.split(path.sep)[0]
      const sessionDir = containedPath(base, first)
      await writeAccessLedger(root, sessionDir, current, timestamp)
    } catch (error) {
      logCode(errorCode(error))
    }
  }

  /**
   * Reads a memory file for an editing command. An oversized file is rejected
   * outright instead of being edited against a truncated view of its content.
   */
  async function safeReadForEdit(resolved) {
    const read = await safeRead(resolved.root, resolved.real)
    if (read.truncated) {
      const error = new Error("Memory file exceeds the bounded read limit")
      error.code = "EFBIG"
      throw error
    }
    return read
  }

  async function locateFile(virtPath, sessionID) {
    const primary = resolvePath(virtPath, sessionID)
    try {
      return { resolved: primary, read: await safeReadForEdit(primary), legacy: false }
    } catch (error) {
      if (error?.code !== "ENOENT" || primary.scope !== "session") throw error
    }
    const legacy = await ownedLegacyResolved(virtPath, sessionID)
    if (!legacy) throw Object.assign(new Error("Path does not exist"), { code: "ENOENT" })
    return { resolved: legacy, read: await safeReadForEdit(legacy), legacy: true }
  }

  async function locatePath(virtPath, sessionID) {
    const candidates = [resolvePath(virtPath, sessionID)]
    if (candidates[0].scope === "session") {
      const legacy = await ownedLegacyResolved(virtPath, sessionID)
      if (legacy) candidates.push(legacy)
    }
    let missing
    for (const resolved of candidates) {
      try {
        await assertSafePath(resolved.root, resolved.real, { allowMissing: false })
        return { resolved, stat: await fs.lstat(resolved.real) }
      } catch (error) {
        if (error?.code === "ENOENT") missing = error
        else throw error
      }
    }
    throw missing ?? Object.assign(new Error("Path does not exist"), { code: "ENOENT" })
  }

  async function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    const queued = previous.then(() => current)
    locks.set(key, queued)
    await previous
    try { return await task() } finally {
      release()
      if (locks.get(key) === queued) locks.delete(key)
    }
  }

  const exists = async (target) => fs.lstat(target).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error))

  async function ownedLegacyCounterpart(virtPath, sessionID) {
    if (!isSessionPath(virtPath)) return undefined
    return ownedLegacyResolved(virtPath, sessionID)
  }

  async function removeLegacyShadow(virtPath, sessionID) {
    const legacy = await ownedLegacyCounterpart(virtPath, sessionID)
    if (!legacy) return
    let stat
    try { stat = await fs.lstat(legacy.real) } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    await safeRemove(legacy.root, legacy.real, stat, beforeMutation)
  }

  async function scopeFiles(resolved, sessionID) {
    if (resolved.scope === "session") return (await mergedSessionEntries(await sessionRoots(sessionID))).filter((entry) => entry.stat.isFile())
    const skipTopLevel = resolved.scope === "user" ? (name) => isReservedUserComponent(name) : undefined
    return (await recursiveEntries(resolved.root, resolved.root, { maxEntries: 10_001, skipTopLevel })).filter((entry) => entry.stat.isFile())
  }

  async function enforceBounds(resolved, sessionID, content, previous, creating = false) {
    const bytes = Buffer.byteLength(content, "utf8")
    if (bytes > MAX_MEMORY_FILE_BYTES) return failure("limit_exceeded", "Error: Memory size limit exceeded.")
    const files = await scopeFiles(resolved, sessionID)
    const totalBytes = files.reduce((sum, entry) => sum + entry.stat.size, 0) - (previous?.stat?.size ?? 0) + bytes
    const totalCount = files.length + (creating ? 1 : 0)
    if (totalCount > MAX_SCOPE_ENTRIES || totalBytes > MAX_SCOPE_BYTES) return failure("limit_exceeded", "Error: Memory scope limit exceeded.")
    if (resolved.scope === "user") {
      let lines = 0
      for (const file of files) lines += (await safeRead(userRoot, file.target)).content.split("\n").length
      lines -= previous ? previous.content.split("\n").length : 0
      lines += content.split("\n").length
      if (lines > MAX_USER_MEMORY_LINES) return failure("limit_exceeded", `Error: User memory is limited to ${MAX_USER_MEMORY_LINES} total lines.`)
    }
    return undefined
  }

  async function writeUpdate(virtPath, sessionID, located, content) {
    const primary = resolvePath(virtPath, sessionID)
    let warning
    try {
      if (located.legacy) await atomicCreateFrom(located.resolved.root, located.resolved.real, primary.root, primary.real, located.read, content, beforeCommit)
      else await atomicUpdate(primary.root, primary.real, located.read, content, beforeCommit)
    } catch (error) {
      if (!error?.committed) throw error
      warning = "durability_warning"
      logCode(errorCode(error))
    }
    if (located.legacy) await removeLegacyShadow(virtPath, sessionID).catch((error) => logCode(errorCode(error)))
    else if (primary.scope === "session") await removeLegacyShadow(virtPath, sessionID).catch((error) => logCode(errorCode(error)))
    await markAccessed(primary.real, primary.root)
    return warning
  }

  async function viewDirectory(resolved, virtPath, sessionID) {
    if (virtPath === "/memories") {
      const currentSessionRoots = typeof sessionID === "string" && sessionID.length > 0 ? await sessionRoots(sessionID) : []
      for (const item of currentSessionRoots) await markAccessed(item.dir, item.scopeRoot)
      const groups = [
        { scopeRoot: userRoot, dir: userRoot, prefix: "", skipTopLevel: (name) => isReservedUserComponent(name) },
        ...currentSessionRoots.map((item) => ({ ...item, prefix: "session/" })),
        { scopeRoot: repoRoot, dir: repoRoot, prefix: "repo/" },
      ]
      return boundedDirectoryListing(groups, [
        { key: "repo/", text: "0\trepo/" },
        { key: "session/", text: "0\tsession/" },
      ])
    }
    if (virtPath === "/memories/session") {
      const currentSessionRoots = await sessionRoots(sessionID)
      for (const item of currentSessionRoots) await markAccessed(item.dir, item.scopeRoot)
      return boundedDirectoryListing(currentSessionRoots.map((item) => ({ ...item, prefix: "" })))
    }
    if (virtPath === "/memories/repo") return boundedDirectoryListing([{ scopeRoot: repoRoot, dir: repoRoot, prefix: "" }])
    return boundedDirectoryListing([{ scopeRoot: resolved.root, dir: resolved.real, prefix: "" }])
  }

  async function evaluate(args = {}, sessionID) {
    // Strict runtime validation runs before anything is dereferenced, so a
    // malformed argument can never throw, hang, or coerce a write.
    const malformed = validateArguments(args)
    if (malformed) return malformed
    const command = args.command
    let safeFailurePath = "/memories/"
    try {
      if (command === "view") {
        const rawPath = args.path ?? "/memories/"
        const pathError = validatePath(rawPath)
        if (pathError) return failure("invalid_path", pathError)
        const virtPath = normalizedVirtualPath(rawPath)
        const publicPath = displayVirtualPath(virtPath)
        safeFailurePath = virtPath
        if (isSessionPath(virtPath)) requireSessionID(sessionID)
        logCode("MEMORY_VIEW")
        if (["/memories", "/memories/session", "/memories/repo"].includes(virtPath)) {
          return success("listed", await viewDirectory(resolvePath(virtPath, sessionID), virtPath, sessionID))
        }
        let located
        try { located = await locatePath(virtPath, sessionID) } catch (error) {
          if (error?.code === "ENOENT") return failure("not_found", `Error: path does not exist: ${publicPath}`)
          throw error
        }
        await markAccessed(located.resolved.real, located.resolved.root)
        if (located.stat.isDirectory()) return success("listed", await viewDirectory(located.resolved, virtPath, sessionID))
        const read = await safeRead(located.resolved.root, located.resolved.real)
        return success("viewed", formatFileContent(publicPath, read.content, args.view_range, read.truncated))
      }

      if (["create", "str_replace", "insert", "delete", "rename"].includes(command)) {
        await cleanupStaleArtifacts(userRoot).catch((error) => logCode(errorCode(error)))
        await cleanupStaleArtifacts(repoRoot).catch((error) => logCode(errorCode(error)))
      }

      if (command === "create") {
        if (!args.path) return failure("invalid_input", "Error: path is required for create")
        if (!("file_text" in args)) return failure("invalid_input", "Error: file_text is required for create")
        const pathError = validatePath(args.path)
        if (pathError) return failure("invalid_path", pathError)
        const virtPath = normalizedVirtualPath(args.path)
        const publicPath = displayVirtualPath(virtPath)
        safeFailurePath = virtPath
        if (["/memories", "/memories/session", "/memories/repo"].includes(virtPath)) return failure("scope_root", "Error: Cannot create a file at a memory scope root.")
        const resolved = resolvePath(virtPath, sessionID)
        return await withLock(resolved.real, async () => {
          if (resolved.scope === "session") {
            const legacy = await ownedLegacyCounterpart(virtPath, sessionID)
            if (legacy && await exists(legacy.real)) return failure("already_exists", `Error: file already exists at ${publicPath}`)
          }
          const limit = await enforceBounds(resolved, sessionID, args.file_text, undefined, true)
          if (limit) return limit
          let warning
          try { await exclusiveCreate(resolved.root, resolved.real, args.file_text, beforeCommit) } catch (error) {
            if (error?.code === "EEXIST") return failure("already_exists", `Error: file already exists at ${publicPath}`)
            if (error?.committed) {
              warning = "durability_warning"
              logCode(errorCode(error))
            } else throw error
          }
          await markAccessed(resolved.real, resolved.root)
          return success("created", `Successfully created ${publicPath}`, warning ? { warning } : undefined)
        })
      }

      if (command === "str_replace") {
        if (!args.path) return failure("invalid_input", "Error: path is required for str_replace")
        if (!("old_str" in args)) return failure("invalid_input", "Error: old_str is required for str_replace")
        if (args.old_str === "") return failure("invalid_input", "Error: old_str must not be empty")
        if (!("new_str" in args)) return failure("invalid_input", "Error: new_str is required for str_replace")
        const pathError = validatePath(args.path)
        if (pathError) return failure("invalid_path", pathError)
        const virtPath = normalizedVirtualPath(args.path)
        const publicPath = displayVirtualPath(virtPath)
        safeFailurePath = virtPath
        const primary = resolvePath(virtPath, sessionID)
        return await withLock(primary.real, async () => {
          let located
          try { located = await locateFile(virtPath, sessionID) } catch (error) {
            if (error?.code === "ENOENT") return failure("not_found", `The path ${publicPath} does not exist. Please provide a valid path.`)
            throw error
          }
          const occurrences = []
          // Overlapping matches count: advance by one code unit so "aa" inside
          // "aaa" is reported as multiple occurrences instead of one.
          for (let index = located.read.content.indexOf(args.old_str); index !== -1; index = located.read.content.indexOf(args.old_str, index + 1)) occurrences.push(located.read.content.slice(0, index).split("\n").length)
          if (occurrences.length === 0) return failure("not_found", `No replacement was performed because old_str did not appear verbatim in ${publicPath}.`)
          if (occurrences.length > 1) return failure("not_unique", `No replacement was performed. Multiple occurrences of old_str were found in lines: ${occurrences.join(", ")}. Please ensure it is unique.`)
          const index = located.read.content.indexOf(args.old_str)
          const content = located.read.content.slice(0, index) + args.new_str + located.read.content.slice(index + args.old_str.length)
          const limit = await enforceBounds(primary, sessionID, content, located.read)
          if (limit) return limit
          const warning = await writeUpdate(virtPath, sessionID, located, content)
          return success("updated", makeSnippet(content, occurrences[0], publicPath), warning ? { warning } : undefined)
        })
      }

      if (command === "insert") {
        if (!args.path) return failure("invalid_input", "Error: path is required for insert")
        if (!("insert_line" in args)) return failure("invalid_input", "Error: insert_line is required for insert")
        // Property presence (not truthiness) decides the source, so an explicit
        // empty `insert_text` is honored instead of silently falling back.
        const hasInsertText = Object.prototype.hasOwnProperty.call(args, "insert_text")
        const hasFallback = Object.prototype.hasOwnProperty.call(args, "new_str")
        if (!hasInsertText && !hasFallback) return failure("invalid_input", "Error: Missing required insert_text parameter for insert.")
        const insertText = hasInsertText ? args.insert_text : args.new_str
        if (typeof insertText !== "string") return failure("invalid_input", "Error: insert text must be a string.")
        const pathError = validatePath(args.path)
        if (pathError) return failure("invalid_path", pathError)
        const virtPath = normalizedVirtualPath(args.path)
        const publicPath = displayVirtualPath(virtPath)
        safeFailurePath = virtPath
        const primary = resolvePath(virtPath, sessionID)
        return await withLock(primary.real, async () => {
          let located
          try { located = await locateFile(virtPath, sessionID) } catch (error) {
            if (error?.code === "ENOENT") return failure("not_found", `Error: The path ${publicPath} does not exist`)
            throw error
          }
          const lines = located.read.content.split("\n")
          if (!Number.isInteger(args.insert_line) || args.insert_line < 0 || args.insert_line > lines.length) return failure("out_of_range", `Error: Invalid insert_line parameter. It should be within the range [0, ${lines.length}].`)
          lines.splice(args.insert_line, 0, ...insertText.split("\n"))
          const content = lines.join("\n")
          const limit = await enforceBounds(primary, sessionID, content, located.read)
          if (limit) return limit
          const warning = await writeUpdate(virtPath, sessionID, located, content)
          return success("updated", makeSnippet(content, args.insert_line + 1, publicPath), warning ? { warning } : undefined)
        })
      }

      if (command === "delete") {
        if (!args.path) return failure("invalid_input", "Error: path is required for delete")
        const pathError = validatePath(args.path)
        if (pathError) return failure("invalid_path", pathError)
        const virtPath = normalizedVirtualPath(args.path)
        const publicPath = displayVirtualPath(virtPath)
        safeFailurePath = virtPath
        if (["/memories", "/memories/session", "/memories/repo"].includes(virtPath)) return failure("scope_root", "Error: Memory scope roots cannot be deleted.")
        const primary = resolvePath(virtPath, sessionID)
        return await withLock(primary.real, async () => {
          let warning
          let located
          try { located = await locatePath(virtPath, sessionID) } catch (error) {
            if (error?.code === "ENOENT") return failure("not_found", `Error: path does not exist: ${publicPath}`)
            throw error
          }
          try {
            await safeRemove(located.resolved.root, located.resolved.real, located.stat, beforeMutation)
          } catch (error) {
            if (error?.committed) {
              warning = "durability_warning"
              logCode(errorCode(error))
            } else {
              throw error
            }
          }
          if (!located.resolved || path.resolve(located.resolved.real) === path.resolve(primary.real)) {
            await removeLegacyShadow(virtPath, sessionID).catch((error) => logCode(errorCode(error)))
          }
          return success("deleted", `Successfully deleted ${publicPath}`, warning ? { warning } : undefined)
        })
      }

      if (command === "rename") {
        const oldPath = args.old_path ?? args.path
        if (!oldPath) return failure("invalid_input", "Error: old_path or path is required for rename")
        if (!args.new_path) return failure("invalid_input", "Error: new_path is required for rename")
        const oldError = validatePath(oldPath)
        const newError = validatePath(args.new_path)
        if (oldError || newError) return failure("invalid_path", oldError ?? newError)
        const oldVirt = normalizedVirtualPath(oldPath)
        const newVirt = normalizedVirtualPath(args.new_path)
        const oldPublic = displayVirtualPath(oldVirt)
        const newPublic = displayVirtualPath(newVirt)
        safeFailurePath = newVirt
        if (["/memories", "/memories/session", "/memories/repo"].includes(oldVirt) || ["/memories", "/memories/session", "/memories/repo"].includes(newVirt)) return failure("scope_root", "Error: Memory scope roots cannot be renamed or replaced.")
        const from = resolvePath(oldVirt, sessionID)
        const to = resolvePath(newVirt, sessionID)
        if (from.scope !== to.scope) return failure("cross_scope", "Error: Cannot rename across different memory scopes.")
        // Destination-keyed serialization preserves no-clobber semantics for
        // concurrent rename/create attempts within this engine instance.
        return await withLock(to.real, async () => {
          let warning
          let located
          try { located = await locatePath(oldVirt, sessionID) } catch (error) {
            if (error?.code === "ENOENT") return failure("not_found", `Error: The path ${oldPublic} does not exist`)
            throw error
          }
          await ensureManagedDir(to.root, path.dirname(to.real))
          await assertSafePath(to.root, to.real)
          if (await exists(to.real)) return failure("already_exists", `Error: The destination ${newPublic} already exists`)
          if (to.scope === "session") {
            const legacyDestination = await ownedLegacyCounterpart(newVirt, sessionID)
            if (legacyDestination && await exists(legacyDestination.real)) return failure("already_exists", `Error: The destination ${newPublic} already exists`)
          }
          try {
            await safeRename(from.root, located.resolved.real, to.real, located.stat, beforeMutation)
          } catch (error) {
            if (error?.committed) {
              warning = "durability_warning"
              logCode(errorCode(error))
            } else {
              if (error?.code === "EEXIST") return failure("already_exists", `Error: The destination ${newPublic} already exists`)
              throw error
            }
          }
          if (path.resolve(located.resolved.real) === path.resolve(from.real)) {
            await removeLegacyShadow(oldVirt, sessionID).catch((error) => logCode(errorCode(error)))
          }
          await markAccessed(to.real, to.root)
          return success("renamed", "Successfully renamed", warning ? { warning } : undefined)
        })
      }

      return failure("unknown_command", "Error: unknown command")
    } catch (error) {
      logCode(errorCode(error))
      return sanitizedFailure(error, safeFailurePath)
    }
  }

  /**
   * Internal entry point: `{ text, outcome }`, where `text` is the exact V1
   * public string and `outcome` carries the typed status code.
   */
  async function runCommand(args = {}, sessionID) {
    const outcome = await evaluate(args, sessionID)
    return { text: outcome.content, outcome }
  }

  const runOutcome = runCommand

  /** Public V1 entry point: the bare string the tool has always returned. */
  async function run(args = {}, sessionID) {
    return (await runCommand(args, sessionID)).text
  }

  async function buildContext(sessionID) {
    requireSessionID(sessionID)
    return buildMemoryContext({ userRoot, repoRoot, sessionRoots: await sessionRoots(sessionID) })
  }

  function cleanupStaleSessionDirs() {
    if (!existsSync(sessionBase)) return 0
    const current = now()
    let deleted = 0
    let baseStat
    let canonicalBase
    try {
      baseStat = lstatSync(sessionBase)
      if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return 0
      canonicalBase = realpathSync(sessionBase)
    } catch { return 0 }

    const insideBase = (target) => {
      const rel = path.relative(path.resolve(sessionBase), path.resolve(target))
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    }
    const sameIdentity = (target, original, directory = false) => {
      try {
        const stat = lstatSync(target)
        return !stat.isSymbolicLink() && stat.dev === original.dev && stat.ino === original.ino && (directory ? stat.isDirectory() : stat.isFile())
      } catch { return false }
    }
    const safeDirectory = (target, original) => {
      if (!insideBase(target) || !sameIdentity(target, original, true)) return false
      try {
        const canonical = realpathSync(target)
        const rel = path.relative(canonicalBase, canonical)
        return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
      } catch { return false }
    }
    const ledgerKey = (sessionDir, target) => {
      const relative = path.relative(path.resolve(sessionDir), path.resolve(target))
      return (relative || ".").split(path.sep).join("/")
    }
    const clean = (dirPath, sessionDir, ledger) => {
      let dirStat
      try { dirStat = lstatSync(dirPath) } catch { return }
      if (!safeDirectory(dirPath, dirStat)) return
      const dirLast = Math.max(dirStat.atimeMs, dirStat.mtimeMs, ledger[ledgerKey(sessionDir, dirPath)] ?? 0)
      let entries
      try { entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => stableCompare(a.name, b.name)) } catch { return }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const item = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          clean(item, sessionDir, ledger)
          continue
        }
        if (entry.name === OWNER_FILE || entry.name === ACCESS_FILE || entry.name.startsWith(TEMP_PREFIX) || entry.name.startsWith(LOCK_PREFIX)) continue
        let stat
        try { stat = lstatSync(item) } catch { continue }
        if (!stat.isFile()) continue
        const last = Math.max(stat.atimeMs, stat.mtimeMs, ledger[ledgerKey(sessionDir, item)] ?? 0)
        if (current - last <= RETENTION_MS || !safeDirectory(dirPath, dirStat) || !sameIdentity(item, stat)) continue
        let refreshed
        try { refreshed = lstatSync(item) } catch { continue }
        const latestLedger = readAccessLedgerSync(userRoot, sessionDir)
        const refreshedLast = Math.max(refreshed.atimeMs, refreshed.mtimeMs, latestLedger[ledgerKey(sessionDir, item)] ?? 0)
        if (refreshed.isSymbolicLink() || !refreshed.isFile() || refreshed.dev !== stat.dev || refreshed.ino !== stat.ino || current - refreshedLast <= RETENTION_MS) continue
        try {
          unlinkSync(item)
          deleted += 1
        } catch {}
      }
      let remaining
      try { remaining = readdirSync(dirPath).filter((name) => name !== OWNER_FILE && name !== ACCESS_FILE) } catch { return }
      let refreshedDir
      try { refreshedDir = lstatSync(dirPath) } catch { return }
      const latestDirLedger = readAccessLedgerSync(userRoot, sessionDir)
      const latestRecordedDirAccess = latestDirLedger[ledgerKey(sessionDir, dirPath)] ?? 0
      if (remaining.length !== 0 || current - Math.max(dirLast, latestRecordedDirAccess) <= RETENTION_MS || refreshedDir.dev !== dirStat.dev || refreshedDir.ino !== dirStat.ino || !safeDirectory(dirPath, dirStat)) return
      for (const name of [OWNER_FILE, ACCESS_FILE]) {
        const metadata = path.join(dirPath, name)
        let metadataStat
        try { metadataStat = lstatSync(metadata) } catch { continue }
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || !safeDirectory(dirPath, dirStat) || !sameIdentity(metadata, metadataStat)) return
        try { unlinkSync(metadata) } catch { return }
      }
      try { if (readdirSync(dirPath).length !== 0) return } catch { return }
      try {
        rmdirSync(dirPath)
        deleted += 1
      } catch {}
    }

    let dirs
    try { dirs = readdirSync(sessionBase, { withFileTypes: true }).sort((a, b) => stableCompare(a.name, b.name)) } catch { return 0 }
    for (const dir of dirs) if (dir.isDirectory() && !dir.isSymbolicLink()) {
      const sessionDir = path.join(sessionBase, dir.name)
      clean(sessionDir, sessionDir, readAccessLedgerSync(userRoot, sessionDir))
    }
    if (deleted) logCode("MEMORY_CLEANUP")
    return deleted
  }

  let timer
  async function cleanupAll() {
    await cleanupStaleArtifacts(userRoot)
    await cleanupStaleArtifacts(repoRoot)
    cleanupStaleSessionDirs()
  }
  function startCleanup() {
    if (timer) return
    timer = setIntervalFn(() => { void cleanupAll().catch((error) => logCode(errorCode(error))) }, CLEANUP_INTERVAL_MS)
    timer?.unref?.()
    void cleanupAll().catch((error) => logCode(errorCode(error)))
  }
  function stopCleanup() {
    if (!timer) return
    clearIntervalFn(timer)
    timer = undefined
  }

  return {
    projectDir, userRoot, repoRoot, sessionRoot, legacySessionRoot, resolvePath,
    run, runCommand, runOutcome, evaluate, buildContext, cleanupStaleSessionDirs, cleanupAll,
    startCleanup, stopCleanup,
  }
}
