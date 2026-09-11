/**
 * opencode-memory — V2 core engine.
 *
 * Pure, dependency-free port of the V1 memory engine (../index.ts). It owns the
 * /memories/ three-tier layout and every read/write operation; the V2 plugin
 * entry (./server.mjs) only wires this engine to the public V2 plugin APIs
 * (`ctx.tool.transform` + `ctx.session.hook("context")`).
 *
 * Layout (unchanged from V1):
 *   /memories/         — user scope     <configDir>/memories/
 *   /memories/session/ — session scope  <configDir>/memories/session/<sessionID>/
 *   /memories/repo/    — repo scope     <projectDir>/.opencode/memories/
 */
import fs from "fs/promises"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import os from "os"
import path from "path"

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const MAX_USER_MEMORY_LINES = 200

export function defaultConfigDir(env = process.env) {
  return env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
}

export const MEMORY_DESCRIPTION = `Manage a persistent memory system with three scopes for storing notes and information across conversations.

Memory is organized under /memories/ with three tiers:
- \`/memories/\` — User memory: global persistent notes shared across all projects in this environment. Store cross-project preferences, common patterns, and general insights here.
- \`/memories/session/\` — Session memory: notes scoped to the current conversation. Store task-specific context and in-progress notes here. Cleared after the conversation ends.
- \`/memories/repo/\` — Repository memory: project-scoped persistent notes stored in the project's .opencode/ directory. Store codebase conventions, architecture decisions, build commands, verified practices, and project-specific facts here. These persist across sessions and are specific to this project.

When to use each scope:
- Use /memories/repo/ for anything specific to the current project (architecture, conventions, gotchas, build steps)
- Use /memories/ for cross-project preferences (coding style, tool preferences, general patterns)
- Use /memories/session/ for temporary working state within the current conversation — keep plans and progress notes up to date here

Guidelines:
- Keep entries short and concise. Prefer multiple focused files over a single large file.
- Do NOT create unnecessary files. Only create memories when explicitly asked or when the information is clearly valuable for future interactions.
- Update or remove outdated memories rather than accumulating stale information.
- Before creating new memory files, first view the appropriate /memories/ directory to see what already exists — this helps avoid duplicates.
- You can have up to 200 lines per file. For longer content, split into multiple files.

Commands (all supported for all scopes):
- \`view\`: View contents of a file or list directory contents.
- \`create\`: Create a new file at the specified path with the given content. Fails if the file already exists.
- \`str_replace\`: Replace an exact string in a file with a new string. The old_str must appear exactly once in the file.
- \`insert\`: Insert text at a specific line number in a file. Line 0 inserts at the beginning.
- \`delete\`: Delete a file or directory (and all its contents).
- \`rename\`: Rename or move a file or directory from path to new_path. Cannot rename across scopes.`

/**
 * Plain JSON Schema (a valid V2 `Tool.ValueSchema`) describing the memory tool
 * input. Kept as a plain object so the V2 core passes it through untouched
 * (`packages/core/src/tool/runtime.ts` inputJsonSchema/decodeInput).
 */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
      description: "The operation to perform on the memory file system.",
    },
    path: {
      type: "string",
      description:
        'The absolute path to the file or directory inside /memories/, e.g. "/memories/notes.md". Used by all commands except `rename`.',
    },
    file_text: { type: "string", description: "Required for `create`. The content of the file to create." },
    old_str: {
      type: "string",
      description: "Required for `str_replace`. The exact string in the file to replace. Must appear exactly once.",
    },
    new_str: { type: "string", description: "Required for `str_replace`. The new string to replace old_str with." },
    insert_line: {
      type: "number",
      description: "Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line.",
    },
    insert_text: { type: "string", description: "Required for `insert`. The text to insert at the specified line." },
    view_range: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      description:
        "Optional for `view`. A two-element array [start_line, end_line] (1-indexed) to view a specific range of lines.",
    },
    old_path: { type: "string", description: "Required for `rename`. The current path of the file or directory to rename." },
    new_path: { type: "string", description: "Required for `rename`. The new path for the file or directory." },
  },
  required: ["command"],
  additionalProperties: false,
}

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function validatePath(p) {
  if (typeof p !== "string" || p.length === 0) return "Error: path is required"
  if (p.includes("..")) return "Error: Path traversal is not allowed"
  const segments = p.split("/").filter((s) => s.length > 0)
  if (segments.some((s) => s === ".")) return "Error: Path traversal is not allowed"
  if (segments[0] !== "memories") return "Error: All memory paths must start with /memories/"
  return undefined
}

function fmtLine(n) {
  return String(n).padStart(6, " ")
}

function formatFileContent(virtPath, content) {
  const lines = content.split("\n")
  const numbered = lines.map((line, i) => fmtLine(i + 1) + "\t" + line)
  return "Here's the content of " + virtPath + " with line numbers:\n" + numbered.join("\n")
}

function makeSnippet(content, editLine, virtPath) {
  const lines = content.split("\n")
  const radius = 4
  const start = Math.max(0, editLine - 1 - radius)
  const end = Math.min(lines.length, editLine - 1 + radius + 1)
  const snippet = lines.slice(start, end)
  const numbered = snippet.map((line, i) => fmtLine(start + i + 1) + "\t" + line)
  return (
    "The memory file has been edited. Here's the result of running `cat -n` on a snippet of " +
    virtPath +
    ":\n" +
    numbered.join("\n")
  )
}

async function viewFile(real, virtPath, range) {
  const stat = statSync(real, { throwIfNoEntry: false })
  if (!stat) return "Error: path does not exist: " + virtPath
  if (stat.isDirectory()) {
    const entries = readdirSync(real, { withFileTypes: true })
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    const lines = []
    for (const e of sorted) {
      const subPath = path.join(real, e.name)
      const size = e.isDirectory() ? 0 : statSync(subPath).size
      lines.push(size + "\t" + (e.isDirectory() ? e.name + "/" : e.name))
      if (e.isDirectory()) {
        try {
          const sub = readdirSync(subPath, { withFileTypes: true })
          for (const se of sub.slice(0, 10)) {
            const subSubPath = path.join(subPath, se.name)
            const subSize = se.isDirectory() ? 0 : statSync(subSubPath).size
            lines.push(subSize + "\t  " + (se.isDirectory() ? se.name + "/" : se.name))
          }
          if (sub.length > 10) lines.push("0\t  ... (" + (sub.length - 10) + " more)")
        } catch {}
      }
    }
    return lines.join("\n") || "(empty directory)"
  }
  const content = await fs.readFile(real, "utf8")
  if (content === undefined) return "Error: could not read file: " + virtPath
  if (!range) return formatFileContent(virtPath, content)
  const lines = content.split("\n")
  const [start, end] = range
  if (start < 1 || start > lines.length)
    return `Error: Invalid view_range: start line ${start} is out of range [1, ${lines.length}].`
  if (end < start || end > lines.length)
    return `Error: Invalid view_range: end line ${end} is out of range [${start}, ${lines.length}].`
  const sliced = lines.slice(start - 1, end)
  const numbered = sliced.map((line, i) => fmtLine(start + i) + "\t" + line)
  return `Here's the content of ${virtPath} (lines ${start}-${end}) with line numbers:\n` + numbered.join("\n")
}

/**
 * Create a memory engine bound to one project + one user-memory root.
 *
 * @param {object} [options]
 * @param {string} [options.projectDir]  project root (repo scope lives in <projectDir>/.opencode/memories)
 * @param {string} [options.userRoot]    user-memory root (defaults to <configDir>/memories)
 * @param {(msg: string) => void} [options.log]
 */
export function createMemory(options = {}) {
  const projectDir = options.projectDir ?? process.cwd()
  const userRoot = options.userRoot ?? path.join(defaultConfigDir(), "memories")
  const log = options.log ?? (() => {})
  const sessionBase = path.join(userRoot, "session")
  const repoRoot = path.join(projectDir, ".opencode", "memories")

  const sessionRoot = (sessionID) =>
    path.join(sessionBase, String(sessionID ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_"))

  function resolvePath(virtPath, sessionID) {
    let normalized = virtPath
    while (normalized.includes("//")) normalized = normalized.split("//").join("/")
    if (!normalized.startsWith("/")) normalized = "/" + normalized

    if (normalized.startsWith("/memories/repo/") || normalized === "/memories/repo") {
      const rel = normalized.slice("/memories/repo".length).replace(/^\//, "")
      return { real: path.join(repoRoot, rel), scope: "repo" }
    }
    if (normalized.startsWith("/memories/session/") || normalized === "/memories/session") {
      const rel = normalized.slice("/memories/session".length).replace(/^\//, "")
      return { real: path.join(sessionRoot(sessionID), rel), scope: "session" }
    }
    if (normalized === "/memories" || normalized === "/memories/") {
      return { real: userRoot, scope: "user" }
    }
    const rel = normalized.slice("/memories".length).replace(/^\//, "")
    if (rel === "session" || rel.startsWith("session/")) {
      const sub = rel.slice("session".length).replace(/^\//, "")
      return { real: path.join(sessionRoot(sessionID), sub), scope: "session" }
    }
    if (rel === "repo" || rel.startsWith("repo/")) {
      const sub = rel.slice("repo".length).replace(/^\//, "")
      return { real: path.join(repoRoot, sub), scope: "repo" }
    }
    return { real: path.join(userRoot, rel), scope: "user" }
  }

  const isSessionPath = (p) => p.startsWith("/memories/session/") || p === "/memories/session"

  const accessTimestamps = new Map()
  const markAccessed = (real) => accessTimestamps.set(real, Date.now())

  function cleanupStaleSessionDirs() {
    if (!existsSync(sessionBase)) return 0
    const now = Date.now()
    const entries = readdirSync(sessionBase, { withFileTypes: true })
    let deleted = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = path.join(sessionBase, entry.name)
      const lastAccess = accessTimestamps.get(dirPath) ?? statSync(dirPath).mtimeMs
      if (now - lastAccess > RETENTION_MS) {
        rmSync(dirPath, { recursive: true, force: true })
        accessTimestamps.delete(dirPath)
        deleted++
      } else {
        try {
          const sub = readdirSync(dirPath)
          if (sub.length === 0) {
            rmSync(dirPath, { recursive: true, force: true })
            accessTimestamps.delete(dirPath)
            deleted++
          }
        } catch {}
      }
    }
    if (deleted > 0) log(`cleaned ${deleted} stale session dirs`)
    return deleted
  }

  /**
   * Run a memory command. Returns the model-facing string result (never throws).
   */
  async function run(args = {}, sessionID) {
    const cmd = args.command
    try {
      switch (cmd) {
        case "view": {
          const p = args.path ?? "/memories/"
          log(`view ${p}`)
          const pathErr = validatePath(p)
          if (pathErr) return pathErr
          const { real } = resolvePath(p, sessionID)
          if (isSessionPath(p)) markAccessed(real)
          ensure(path.dirname(real))
          if (p === "/memories/" || p === "/memories") {
            ensure(real)
            const entries = readdirSync(real, { withFileTypes: true })
            const lines = entries.map((e) => {
              const size = e.isDirectory() ? 0 : statSync(path.join(real, e.name)).size
              return size + "\t" + (e.isDirectory() ? e.name + "/" : e.name)
            })
            if (existsSync(repoRoot)) {
              const repoEntries = readdirSync(repoRoot)
              lines.push("0\trepo/ (" + repoEntries.length + " items, project-scoped)")
            } else {
              lines.push("0\trepo/ (empty, project-scoped)")
            }
            return lines.join("\n") || "(empty directory)"
          }
          return await viewFile(real, p, args.view_range)
        }

        case "create": {
          log(`create ${args.path}`)
          if (!args.path) return "Error: path is required for create"
          if (args.file_text === undefined) return "Error: file_text is required for create"
          const createPathErr = validatePath(args.path)
          if (createPathErr) return createPathErr
          const { real } = resolvePath(args.path, sessionID)
          if (isSessionPath(args.path)) markAccessed(real)
          if (existsSync(real)) return "Error: file already exists at " + args.path
          ensure(path.dirname(real))
          await fs.writeFile(real, args.file_text, "utf8")
          return "Successfully created " + args.path
        }

        case "str_replace": {
          log(`str_replace ${args.path}`)
          if (!args.path) return "Error: path is required for str_replace"
          if (args.old_str === undefined) return "Error: old_str is required for str_replace"
          if (args.new_str === undefined) return "Error: new_str is required for str_replace"
          const strPathErr = validatePath(args.path)
          if (strPathErr) return strPathErr
          const { real: strReal } = resolvePath(args.path, sessionID)
          if (isSessionPath(args.path)) markAccessed(strReal)
          let strContent
          try {
            strContent = await fs.readFile(strReal, "utf8")
          } catch {
            return "The path " + args.path + " does not exist. Please provide a valid path."
          }
          const occurrences = []
          let searchStart = 0
          while (true) {
            const idx = strContent.indexOf(args.old_str, searchStart)
            if (idx === -1) break
            occurrences.push(strContent.substring(0, idx).split("\n").length)
            searchStart = idx + 1
          }
          if (occurrences.length === 0) {
            return (
              "No replacement was performed, old_str `" +
              args.old_str +
              "` did not appear verbatim in " +
              args.path +
              "."
            )
          }
          if (occurrences.length > 1) {
            return (
              "No replacement was performed. Multiple occurrences of old_str `" +
              args.old_str +
              "` in lines: " +
              occurrences.join(", ") +
              ". Please ensure it is unique."
            )
          }
          const newContent = strContent.replace(args.old_str, args.new_str)
          await fs.writeFile(strReal, newContent, "utf8")
          return makeSnippet(newContent, occurrences[0], args.path)
        }

        case "insert": {
          log(`insert ${args.path}`)
          if (!args.path) return "Error: path is required for insert"
          if (args.insert_line === undefined) return "Error: insert_line is required for insert"
          const insertText = args.insert_text ?? args.new_str
          if (!insertText) return "Error: Missing required insert_text parameter for insert."
          const insPathErr = validatePath(args.path)
          if (insPathErr) return insPathErr
          const { real: insReal } = resolvePath(args.path, sessionID)
          if (isSessionPath(args.path)) markAccessed(insReal)
          let insContent
          try {
            insContent = await fs.readFile(insReal, "utf8")
          } catch {
            return "Error: The path " + args.path + " does not exist"
          }
          const insLines = insContent.split("\n")
          const nLines = insLines.length
          if (args.insert_line < 0 || args.insert_line > nLines) {
            return (
              "Error: Invalid insert_line parameter: " +
              args.insert_line +
              ". It should be within the range [0, " +
              nLines +
              "]."
            )
          }
          const newInsLines = insertText.split("\n")
          insLines.splice(args.insert_line, 0, ...newInsLines)
          const insResult = insLines.join("\n")
          await fs.writeFile(insReal, insResult, "utf8")
          return makeSnippet(insResult, args.insert_line + 1, args.path)
        }

        case "delete": {
          log(`delete ${args.path}`)
          if (!args.path) return "Error: path is required for delete"
          const delPathErr = validatePath(args.path)
          if (delPathErr) return delPathErr
          const { real } = resolvePath(args.path, sessionID)
          if (isSessionPath(args.path)) markAccessed(path.dirname(real))
          const stat = statSync(real, { throwIfNoEntry: false })
          if (!stat) return "Error: path does not exist: " + args.path
          await fs.rm(real, { recursive: true })
          return "Successfully deleted " + args.path
        }

        case "rename": {
          const oldPath = args.old_path ?? args.path
          log(`rename ${oldPath} -> ${args.new_path}`)
          if (!oldPath) return "Error: old_path or path is required for rename"
          if (!args.new_path) return "Error: new_path is required for rename"
          const renOldErr = validatePath(oldPath)
          if (renOldErr) return renOldErr
          const renNewErr = validatePath(args.new_path)
          if (renNewErr) return renNewErr
          const from = resolvePath(oldPath, sessionID)
          const to = resolvePath(args.new_path, sessionID)
          if (from.scope !== to.scope) return "Error: Cannot rename across different memory scopes."
          if (isSessionPath(oldPath)) markAccessed(from.real)
          if (isSessionPath(args.new_path)) markAccessed(to.real)
          const fromStat = statSync(from.real, { throwIfNoEntry: false })
          if (!fromStat) return "Error: The path " + oldPath + " does not exist"
          const toStat = statSync(to.real, { throwIfNoEntry: false })
          if (toStat) return "Error: The destination " + args.new_path + " already exists"
          ensure(path.dirname(to.real))
          await fs.rename(from.real, to.real)
          return "Successfully renamed"
        }

        default:
          return "Error: unknown command: " + cmd
      }
    } catch (e) {
      log(`execute error ${e?.message ?? String(e)}`)
      return "Error: " + (e?.message ?? String(e))
    }
  }

  async function getUserMemoryContent() {
    if (!existsSync(userRoot)) return undefined
    const entries = readdirSync(userRoot, { withFileTypes: true })
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."))
    if (files.length === 0) return undefined
    const lines = []
    for (const f of files) {
      if (lines.length >= MAX_USER_MEMORY_LINES) break
      const content = await fs.readFile(path.join(userRoot, f.name), "utf8").catch(() => "")
      if (content) lines.push("## " + f.name, ...content.split("\n"))
    }
    if (lines.length === 0) return undefined
    return lines.slice(0, MAX_USER_MEMORY_LINES).join("\n")
  }

  function listFiles(dir, virtualPrefix) {
    if (!existsSync(dir)) return undefined
    const entries = readdirSync(dir, { withFileTypes: true })
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => virtualPrefix + e.name)
    return files.length > 0 ? files : undefined
  }

  /** Build the <userMemory>/<sessionMemory>/<repoMemory> context block. */
  async function buildContext(sessionID) {
    const userContent = await getUserMemoryContent()
    const sessionFiles = listFiles(sessionRoot(sessionID), "/memories/session/")
    const repoFiles = listFiles(repoRoot, "/memories/repo/")

    const context = []

    context.push("<userMemory>")
    if (userContent) {
      context.push(
        "The following are your persistent user memory notes. These persist across all projects and conversations.\n",
      )
      context.push(userContent)
    } else {
      context.push(
        "No user preferences or notes saved yet. Use the memory tool to store persistent notes under /memories/.",
      )
    }
    context.push("</userMemory>")

    context.push("<sessionMemory>")
    if (sessionFiles && sessionFiles.length > 0) {
      context.push(
        "The following files exist in your session memory (/memories/session/). Use the memory tool to read them if needed.\n",
      )
      context.push(sessionFiles.join("\n"))
    } else {
      context.push("Session memory (/memories/session/) is empty. No session notes have been created yet.")
    }
    context.push("</sessionMemory>")

    context.push("<repoMemory>")
    if (repoFiles && repoFiles.length > 0) {
      context.push(
        "The following files exist in your repository memory (/memories/repo/). These are scoped to the current project. Use the memory tool to read them if needed.\n",
      )
      context.push(repoFiles.join("\n"))
    } else {
      context.push("Repository memory (/memories/repo/) is empty. No project-scoped notes have been created yet.")
    }
    context.push("</repoMemory>")

    return context.join("\n")
  }

  let timer
  function startCleanup() {
    if (timer) return
    timer = setInterval(() => {
      try {
        cleanupStaleSessionDirs()
      } catch {}
    }, CLEANUP_INTERVAL_MS)
    timer.unref?.()
    try {
      cleanupStaleSessionDirs()
    } catch {}
  }
  function stopCleanup() {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    projectDir,
    userRoot,
    repoRoot,
    sessionRoot,
    resolvePath,
    run,
    buildContext,
    cleanupStaleSessionDirs,
    startCleanup,
    stopCleanup,
  }
}
