# opencode-memory

Standalone OpenCode plugin that ports the `patch-memory` fork patch into an external plugin.

## What it does

- **Registers a `memory` tool** via the OpenCode plugin `tool` hook
- **Injects memory context** into the system prompt via `experimental.chat.system.transform`

## Memory tiers

| Path | Scope | Location |
|------|-------|----------|
| `/memories/` | User | `$OPENCODE_CONFIG_DIR/memories/` |
| `/memories/session/` | Session | `$OPENCODE_CONFIG_DIR/memories/session/<sha256(sessionID)>/` |
| `/memories/repo/` | Repo | `<project>/.opencode/memories/` |

Session directories are keyed by the SHA-256 of the exact session ID, so IDs that
differ only by punctuation can never collide. Directories written by older
versions (sanitized session names) are atomically claimed by their first exact
session owner and remain readable without eager migration. A legacy shadow is
removed when its entry is changed, renamed, or deleted.

**Retention.** Session scope is not permanent. Each entry is removed once more
than 14 days have passed since the newest of its access time, modification time,
or the last time this plugin touched it. Empty session directories are removed
under the same rule. The sweep runs hourly and its timer is `unref`'d.

## Commands

| Command | Description |
|---------|-------------|
| `view` | List directory or read file (with optional line range) |
| `create` | Create a new file (fails if it exists) |
| `str_replace` | Replace one exact, unique, non-empty string |
| `insert` | Insert text at a 0-based line number |
| `delete` | Delete a file or non-scope-root directory |
| `rename` | Move/rename within one scope; scope roots cannot be renamed |

Listings and injected context are bounded (entry, line, and character limits),
XML-escaped, and recursive. User memory contributes at most 200 total lines, and
a `/memories/` listing shows the user scope plus only the current session's and
current project's entries. Every user-supplied entry counts toward those limits,
including dot-prefixed names such as `/memories/.notes.md`, which are ordinary
user memories: they are listed, injected, and directly readable. Only the
plugin's own bookkeeping names (`.memory-owner`, `.memory-access`, `.memory-tmp-*`,
`.memory-lock-*`) are hidden from listings, walking, and accounting, and they
cannot be created or used as a rename target.

Commands are validated strictly at runtime, independently of the advertised tool
schema: structurally malformed arguments (non-object arguments, wrong primitive
types, non-integer line numbers, malformed ranges) always return the same
`Error: invalid arguments` result and never throw, coerce, or write.

## Storage hardening

Every path is resolved through `memory-safe-fs.mjs` before it is touched:

- canonical containment inside the managed scope, so no path can escape it
- symlinked components — including a symlink swapped in as the final component —
  are rejected, and file reads/creates use `O_NOFOLLOW`
- reads open the final target, `fstat`-check its size, and read at most the
  configured maximum plus one sentinel byte into a pre-sized buffer, so an
  externally seeded oversized file is never slurped whole: `view` output carries
  a truncation marker, injected context is bounded before rendering, and edits
  refuse an oversized file instead of rewriting a truncated view
- access-ledger bookkeeping is best effort: a ledger failure before or after a
  read or a committed mutation is reduced to a sanitized code and never changes
  the command or context result
- newly managed directories are created `0700` and files `0600`; existing modes
  are preserved
- `create` is `O_EXCL` and never clobbers an existing file, even under
  concurrent calls
- edits are written to a same-directory temp file with the destination's existing
  mode (`0600` for a new file), `fsync`ed, re-checked against the dev/inode/content
  that was read, renamed over the target, and the parent directory is synced;
  failed writes clean up their temp file and leave the original content untouched
- `delete` and `rename` re-validate identity immediately before mutating
- same-directory `wx` lock files serialize participating writers across
  processes; file rename claims its destination with a hard link before unlinking
  the source
- directory rename is locked and revalidated, but Node has no portable
  `renameat2(RENAME_NOREPLACE)`: an uncooperative process can still race the final
  destination-missing check

Memory content is agent-authored and may be stale or wrong: **verify important
information before relying on it, and never store passwords, tokens, API keys, or
other secrets.**

## Installation

### npm (recommended)

```json
{
  "plugin": ["@lkonga/opencode-memory-tool"]
}
```

### Local file path (npm not desired)

If you don't want to install with npm, use `file://` paths. Add to `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-memory/index.ts"]
}
```

`index.ts` is the only plugin entry point; `memory-core.mjs`,
`memory-context.mjs`, `memory-access-ledger.mjs`, and `memory-safe-fs.mjs` are
its runtime helpers and must ship alongside it.

## Configuration

Set `memory_tool_enabled` to `false` (boolean) or `"false"` (string) in
`$OPENCODE_CONFIG_DIR/execsa-config.json` to register nothing at all. Set
`debug_logging` to `true`/`"true"` for sanitized code-only diagnostics.

## Relationship to patch-memory.ts

This plugin replaces the registry.ts and prompt.ts patches from `patch-memory.ts`.
The `memory.ts` and `memory.txt` file creation in the patch script is kept for now
as a compatibility shim, but tool registration and system prompt injection are
handled entirely by this plugin.
