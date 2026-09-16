/**
 * opencode-memory — Persistent memory plugin for OpenCode (V1 runtime)
 *
 * Registers the MemoryTool via the plugin `tool` hook and auto-injects
 * memory contents into the system prompt via `experimental.chat.system.transform`.
 *
 * Memory is organized under /memories/ with three tiers:
 *   - /memories/        — User-scoped: global across all projects ($OPENCODE_CONFIG_DIR/memories/)
 *   - /memories/session/ — Session-scoped: 14-day inactivity retention, SHA-256 keyed
 *   - /memories/repo/    — Repo-scoped: stored in <project>/.opencode/memories/
 *
 * All filesystem work is delegated to the hardened engine in ./memory-core.mjs:
 * canonical containment, symlink rejection, 0700/0600 private writes, durable
 * atomic updates, no-clobber concurrency, and bounded sanitized reads. This
 * module only adapts that engine to the V1 plugin/tool/zod contract and keeps
 * the historical public tool strings unchanged.
 */
import { z } from "zod"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import path from "path"
import { existsSync, readFileSync } from "fs"
import {
  createMemory,
  defaultConfigDir,
  errorCode,
  MEMORY_DESCRIPTION,
} from "./memory-core.mjs"

/** Marker that identifies the execsa subagent's system prompt. */
const SUBAGENT_MARKER = "execution-focused subagent"

function configDir(): string {
  return defaultConfigDir()
}

function readPluginConfig(dir: string): Record<string, unknown> {
  try {
    const p = path.join(dir, "execsa-config.json")
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"))
  } catch {}
  return {}
}

// ─── Plugin entry ─────────────────────────────────────────────────────────────

export const plugin: Plugin = async (input, options) => {
  const opts: Record<string, any> = (options as Record<string, any> | undefined) ?? {}
  const cfg = readPluginConfig(configDir())

  const debugEnabled = opts.debug_logging === true || cfg.debug_logging === "true"
  // Config may come from execsa-config.json (string) or plugin options (boolean).
  const disabledByConfig = cfg.memory_tool_enabled === false || cfg.memory_tool_enabled === "false"
  const disabledByOptions = opts.memory_tool_enabled === false || opts.memory_tool_enabled === "false"
  const memoryEnabled = !disabledByConfig && !disabledByOptions

  const log = debugEnabled
    ? (code: string) => console.error(code)
    : () => {}

  if (!memoryEnabled) {
    log("MEMORY_DISABLED")
    return {}
  }

  const projectDir = path.resolve(opts.projectDir ?? input?.directory ?? process.cwd())
  const userRoot = path.resolve(opts.userRoot ?? path.join(configDir(), "memories"))

  // Test/embedder seams (`beforeCommit`, `beforeMutation`, `now`, timers) are
  // injected through plugin options and default inside the engine.
  const memory = createMemory({
    projectDir,
    userRoot,
    log,
    now: opts.now,
    beforeCommit: opts.beforeCommit,
    beforeMutation: opts.beforeMutation,
    setInterval: opts.setInterval,
    clearInterval: opts.clearInterval,
  })

  // Hourly stale-session sweep. The timer is unref'd so it never holds the
  // process open; the V1 Hooks contract has no plugin-disposal callback.
  memory.startCleanup()
  log("MEMORY_PLUGIN_LOADED")

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
              "Required for `str_replace`. The exact, non-empty string in the file to replace. Must appear exactly once.",
            ),
          new_str: z
            .string()
            .optional()
            .describe(
              "Required for `str_replace`. The new string to replace old_str with. Also acts as an `insert` fallback when `insert_text` is absent.",
            ),
          insert_line: z
            .number()
            .optional()
            .describe(
              "Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line.",
            ),
          insert_text: z
            .string()
            .optional()
            .describe("Required for `insert`. The text to insert at the specified line; may be empty."),
          view_range: z
            .array(z.number())
            .length(2)
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

        // Public V1 contract: a bare string result, exactly as before.
        async execute(args: any, ctx: any) {
          return memory.run(args ?? {}, ctx?.sessionID)
        },
      }),
    },

    // ── Inject memory context into system prompt ──────────────────────────────
    "experimental.chat.system.transform": async (
      hookInput: { sessionID?: string; model?: any },
      output: { system: string[] },
    ) => {
      const sessionID = hookInput?.sessionID
      if (!sessionID) return

      // Skip memory context injection for execsa subagent — it doesn't need project memories.
      if (output.system.some((s) => s.includes(SUBAGENT_MARKER))) return

      let memCtx: string | undefined
      try {
        memCtx = await memory.buildContext(sessionID)
      } catch (e: any) {
        log(errorCode(e))
        return
      }
      if (memCtx) {
        output.system.push(memCtx)
      }
    },
  }
}

export default plugin
