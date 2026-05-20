# opencode-memory

Standalone OpenCode plugin that ports the `patch-memory` fork patch into an external plugin.

## What it does

- **Registers a `memory` tool** via the OpenCode plugin `tool` hook
- **Injects memory context** into the system prompt via `experimental.chat.system.transform`

## Memory tiers

| Path | Scope | Location |
|------|-------|----------|
| `/memories/` | User | `$OPENCODE_CONFIG_DIR/memories/` |
| `/memories/session/` | Session | `$OPENCODE_CONFIG_DIR/memories/session/<sessionID>/` |
| `/memories/repo/` | Repo | `<project>/.opencode/memories/` |

## Commands

| Command | Description |
|---------|-------------|
| `view` | List directory or read file (with optional line range) |
| `create` | Create a new file (fails if exists) |
| `str_replace` | Replace exact string (must be unique in file) |
| `insert` | Insert text at a line number |
| `delete` | Delete file or directory |
| `rename` | Move/rename within same scope |

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

## Relationship to patch-memory.ts

This plugin replaces the registry.ts and prompt.ts patches from `patch-memory.ts`.
The `memory.ts` and `memory.txt` file creation in the patch script is kept for now
as a compatibility shim, but tool registration and system prompt injection are
handled entirely by this plugin.
