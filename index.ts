/**
 * opencode-memory — Persistent memory plugin for OpenCode
 *
 * Registers the MemoryTool via the plugin `tool` hook and auto-injects
 * memory contents into the system prompt via `experimental.chat.system.transform`.
 *
 * Memory is organized under /memories/ with three tiers:
 *   - /memories/        — User-scoped: global across all projects ($OPENCODE_CONFIG_DIR/memories/)
 *   - /memories/session/ — Session-scoped: cleared when session ends
 *   - /memories/repo/    — Repo-scoped: stored in <project>/.opencode/memories/repo/
 */
import { z } from "zod"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs/promises"
import { existsSync, mkdirSync, statSync, readdirSync, rmSync, readFileSync } from "fs"
import os from "os"

// ─── Constants ────────────────────────────────────────────────────────────────

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

function configDir(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ??
    path.join(os.homedir(), ".config", "opencode")
  )
}

function userMemoryRoot(): string {
  return path.join(configDir(), "memories")
}

function sessionMemoryRoot(sessionID: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_.-]/g, "_")
  return path.join(userMemoryRoot(), "session", safe)
}

function repoMemoryRoot(projectDir: string): string {
  return path.join(projectDir, ".opencode", "memories")
}

function ensure(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function validatePath(p: string): string | undefined {
  if (p.includes("..")) return "Error: Path traversal is not allowed"
  const segments = p.split("/").filter((s) => s.length > 0)
  if (segments.some((s) => s === ".")) return "Error: Path traversal is not allowed"
  if (segments[0] !== "memories") return "Error: All memory paths must start with /memories/"
  return undefined
}

type Scope = "user" | "session" | "repo"

function resolvePath(
  virtPath: string,
  sessionID: string,
  projectDir: string,
): { real: string; scope: Scope } {
  let normalized = virtPath
  while (normalized.includes("//")) normalized = normalized.split("//").join("/")
  if (!normalized.startsWith("/")) normalized = "/" + normalized

  if (normalized.startsWith("/memories/repo/") || normalized === "/memories/repo") {
    const rel = normalized.slice("/memories/repo".length).replace(/^\//, "")
    return { real: path.join(repoMemoryRoot(projectDir), rel), scope: "repo" }
  }
  if (normalized.startsWith("/memories/session/") || normalized === "/memories/session") {
    const rel = normalized.slice("/memories/session".length).replace(/^\//, "")
    return { real: path.join(sessionMemoryRoot(sessionID), rel), scope: "session" }
  }
  if (normalized === "/memories" || normalized === "/memories/") {
    return { real: userMemoryRoot(), scope: "user" }
  }
  const rel = normalized.slice("/memories".length).replace(/^\//, "")
  if (rel === "session" || rel.startsWith("session/")) {
    const sub = rel.slice("session".length).replace(/^\//, "")
    return { real: path.join(sessionMemoryRoot(sessionID), sub), scope: "session" }
  }
  if (rel === "repo" || rel.startsWith("repo/")) {
    const sub = rel.slice("repo".length).replace(/^\//, "")
    return { real: path.join(repoMemoryRoot(projectDir), sub), scope: "repo" }
  }
  return { real: path.join(userMemoryRoot(), rel), scope: "user" }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtLine(n: number) {
  return String(n).padStart(6, " ")
}

function formatFileContent(virtPath: string, content: string) {
  const lines = content.split("\n")
  const numbered = lines.map((line, i) => fmtLine(i + 1) + "\t" + line)
  return "Here's the content of " + virtPath + " with line numbers:\n" + numbered.join("\n")
}

function makeSnippet(content: string, editLine: number, virtPath: string) {
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

async function viewFile(real: string, virtPath: string, range?: [number, number]) {
  const stat = statSync(real, { throwIfNoEntry: false })
  if (!stat) return "Error: path does not exist: " + virtPath
  if (stat.isDirectory()) {
    const entries = readdirSync(real, { withFileTypes: true })
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    const lines: string[] = []
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

// ─── Memory context (for system prompt injection) ─────────────────────────────

const MAX_USER_MEMORY_LINES = 200

async function getUserMemoryContent(): Promise<string | undefined> {
  const dir = userMemoryRoot()
  if (!existsSync(dir)) return undefined
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."))
  if (files.length === 0) return undefined
  const lines: string[] = []
  for (const f of files) {
    if (lines.length >= MAX_USER_MEMORY_LINES) break
    const content = await fs.readFile(path.join(dir, f.name), "utf8").catch(() => "")
    if (content) lines.push("## " + f.name, ...content.split("\n"))
  }
  if (lines.length === 0) return undefined
  return lines.slice(0, MAX_USER_MEMORY_LINES).join("\n")
}

function getSessionMemoryFiles(sessionID: string): string[] | undefined {
  const dir = sessionMemoryRoot(sessionID)
  if (!existsSync(dir)) return undefined
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => "/memories/session/" + e.name)
  return files.length > 0 ? files : undefined
}

function getRepoMemoryFiles(projectDir: string): string[] | undefined {
  const dir = repoMemoryRoot(projectDir)
  if (!existsSync(dir)) return undefined
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => "/memories/repo/" + e.name)
  return files.length > 0 ? files : undefined
}

async function buildMemoryContext(sessionID: string, projectDir: string): Promise<string> {
  const userContent = await getUserMemoryContent()
  const sessionFiles = getSessionMemoryFiles(sessionID)
  const repoFiles = getRepoMemoryFiles(projectDir)

  const context: string[] = []

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
    context.push(
      "Session memory (/memories/session/) is empty. No session notes have been created yet.",
    )
  }
  context.push("</sessionMemory>")

  context.push("<repoMemory>")
  if (repoFiles && repoFiles.length > 0) {
    context.push(
      "The following files exist in your repository memory (/memories/repo/). These are scoped to the current project. Use the memory tool to read them if needed.\n",
    )
    context.push(repoFiles.join("\n"))
  } else {
    context.push(
      "Repository memory (/memories/repo/) is empty. No project-scoped notes have been created yet.",
    )
  }
  context.push("</repoMemory>")

  return context.join("\n")
}

// ─── Tool description ─────────────────────────────────────────────────────────

const MEMORY_DESCRIPTION = `Manage a persistent memory system with three scopes for storing notes and information across conversations.

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

// ─── Plugin entry ─────────────────────────────────────────────────────────────

export const plugin: Plugin = async (_ctx: { directory?: string }) => {
  const projectDir = _ctx.directory ?? process.cwd()

  function readExperimentalConfig(): Record<string, string> {
    try {
      const p = path.join(configDir(), "execsa-config.json")
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"))
    } catch {}
    return {}
  }

  const expCfg = readExperimentalConfig()
  const experimentalEnabled = expCfg.experimental_features === "true"

  const accessTimestamps = new Map<string, number>()
  let cleanupStarted = false

  function markAccessed(real: string) {
    if (!experimentalEnabled) return
    accessTimestamps.set(real, Date.now())
  }

  function isSessionPath(p: string): boolean {
    return p.startsWith("/memories/session/") || p === "/memories/session"
  }

  function cleanupStaleSessionDirs() {
    const sessionBase = path.join(configDir(), "memories", "session")
    if (!existsSync(sessionBase)) return
    const now = Date.now()
    const entries = readdirSync(sessionBase, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = path.join(sessionBase, entry.name)
      const lastAccess = accessTimestamps.get(dirPath) ?? statSync(dirPath).mtimeMs
      if (now - lastAccess > RETENTION_MS) {
        rmSync(dirPath, { recursive: true, force: true })
        accessTimestamps.delete(dirPath)
      } else {
        try {
          const sub = readdirSync(dirPath)
          if (sub.length === 0) {
            rmSync(dirPath, { recursive: true, force: true })
            accessTimestamps.delete(dirPath)
          }
        } catch {}
      }
    }
  }

  function startCleanup() {
    if (cleanupStarted) return
    cleanupStarted = true
    setInterval(() => { try { cleanupStaleSessionDirs() } catch {} }, CLEANUP_INTERVAL_MS)
    try { cleanupStaleSessionDirs() } catch {}
  }

  if (experimentalEnabled) startCleanup()

  return {
    // ── Register the memory tool ──────────────────────────────────────────────
    tool: {
      memory: tool({
        description: MEMORY_DESCRIPTION,
        args: {
          command: z
            .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
            .describe("The operation to perform on the memory file system."),
          path: z
            .string()
            .optional()
            .describe(
              'The absolute path to the file or directory inside /memories/, e.g. "/memories/notes.md". Used by all commands except `rename`.',
            ),
          file_text: z
            .string()
            .optional()
            .describe("Required for `create`. The content of the file to create."),
          old_str: z
            .string()
            .optional()
            .describe(
              "Required for `str_replace`. The exact string in the file to replace. Must appear exactly once.",
            ),
          new_str: z
            .string()
            .optional()
            .describe("Required for `str_replace`. The new string to replace old_str with."),
          insert_line: z
            .number()
            .optional()
            .describe(
              "Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line.",
            ),
          insert_text: z
            .string()
            .optional()
            .describe("Required for `insert`. The text to insert at the specified line."),
          view_range: z
            .tuple([z.number(), z.number()])
            .optional()
            .describe(
              "Optional for `view`. A two-element array [start_line, end_line] (1-indexed) to view a specific range of lines.",
            ),
          old_path: z
            .string()
            .optional()
            .describe("Required for `rename`. The current path of the file or directory to rename."),
          new_path: z
            .string()
            .optional()
            .describe("Required for `rename`. The new path for the file or directory."),
        },

        async execute(args: any, ctx: any) {
          const sessionID: string = ctx.sessionID
          const cmd: string = args.command

          try {
            switch (cmd) {
              case "view": {
                const p: string = args.path ?? "/memories/"
                const pathErr = validatePath(p)
                if (pathErr) return pathErr
                const { real } = resolvePath(p, sessionID, projectDir)
                if (isSessionPath(p)) markAccessed(real)
                ensure(path.dirname(real))
                if (p === "/memories/" || p === "/memories") {
                  ensure(real)
                  const entries = readdirSync(real, { withFileTypes: true })
                  const lines = entries.map((e) => {
                    const size = e.isDirectory() ? 0 : statSync(path.join(real, e.name)).size
                    return size + "\t" + (e.isDirectory() ? e.name + "/" : e.name)
                  })
                  const repoDir = repoMemoryRoot(projectDir)
                  if (existsSync(repoDir)) {
                    const repoEntries = readdirSync(repoDir)
                    lines.push("0\trepo/ (" + repoEntries.length + " items, project-scoped)")
                  } else {
                    lines.push("0\trepo/ (empty, project-scoped)")
                  }
                  return lines.join("\n") || "(empty directory)"
                }
                return await viewFile(real, p, args.view_range as [number, number] | undefined)
              }

              case "create": {
                if (!args.path) return "Error: path is required for create"
                if (args.file_text === undefined) return "Error: file_text is required for create"
                const createPathErr = validatePath(args.path)
                if (createPathErr) return createPathErr
                const { real } = resolvePath(args.path, sessionID, projectDir)
                if (isSessionPath(args.path)) markAccessed(real)
                if (existsSync(real)) return "Error: file already exists at " + args.path
                ensure(path.dirname(real))
                await fs.writeFile(real, args.file_text, "utf8")
                return "Successfully created " + args.path
              }

              case "str_replace": {
                if (!args.path) return "Error: path is required for str_replace"
                if (args.old_str === undefined) return "Error: old_str is required for str_replace"
                if (args.new_str === undefined) return "Error: new_str is required for str_replace"
                const strPathErr = validatePath(args.path)
                if (strPathErr) return strPathErr
                const { real: strReal } = resolvePath(args.path, sessionID, projectDir)
                if (isSessionPath(args.path)) markAccessed(strReal)
                let strContent: string
                try {
                  strContent = await fs.readFile(strReal, "utf8")
                } catch {
                  return "The path " + args.path + " does not exist. Please provide a valid path."
                }
                const occurrences: number[] = []
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
                if (!args.path) return "Error: path is required for insert"
                if (args.insert_line === undefined) return "Error: insert_line is required for insert"
                const insertText = args.insert_text ?? args.new_str
                if (!insertText) return "Error: Missing required insert_text parameter for insert."
                const insPathErr = validatePath(args.path)
                if (insPathErr) return insPathErr
                const { real: insReal } = resolvePath(args.path, sessionID, projectDir)
                if (isSessionPath(args.path)) markAccessed(insReal)
                let insContent: string
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
                if (!args.path) return "Error: path is required for delete"
                const delPathErr = validatePath(args.path)
                if (delPathErr) return delPathErr
                const { real } = resolvePath(args.path, sessionID, projectDir)
                if (isSessionPath(args.path)) markAccessed(path.dirname(real))
                const stat = statSync(real, { throwIfNoEntry: false })
                if (!stat) return "Error: path does not exist: " + args.path
                await fs.rm(real, { recursive: true })
                return "Successfully deleted " + args.path
              }

              case "rename": {
                const oldPath = args.old_path ?? args.path
                if (!oldPath) return "Error: old_path or path is required for rename"
                if (!args.new_path) return "Error: new_path is required for rename"
                const renOldErr = validatePath(oldPath)
                if (renOldErr) return renOldErr
                const renNewErr = validatePath(args.new_path)
                if (renNewErr) return renNewErr
                const from = resolvePath(oldPath, sessionID, projectDir)
                const to = resolvePath(args.new_path, sessionID, projectDir)
                if (from.scope !== to.scope)
                  return "Error: Cannot rename across different memory scopes."
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
          } catch (e: any) {
            return "Error: " + (e?.message ?? String(e))
          }
        },
      }),
    },

    // ── Inject memory context into system prompt ──────────────────────────────
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: any },
      output: { system: string[] },
    ) => {
      const sessionID = input.sessionID
      if (!sessionID) return

      // Skip memory context injection for execsa subagent — it doesn't need project memories.
      if (output.system.some((s) => s.includes("execution-focused subagent"))) return

      const memCtx = await buildMemoryContext(sessionID, projectDir)
      if (memCtx) {
        output.system.push(memCtx)
      }
    },
  }
}

export default plugin
