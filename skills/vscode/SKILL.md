---
name: vscode
description: Inspect VS Code Problems, Output, Debug Console, or Terminal, reload the workbench, and clean the Java language server workspace through explicit independent actions
argument-hint: <problems|output|debug-console|terminal|reload|java-clean> [action ...] [options]
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion, mcp__plugin_vscode-agent-bridge_vscode__list_windows, mcp__plugin_vscode-agent-bridge_vscode__get_diagnostics, mcp__plugin_vscode-agent-bridge_vscode__execute_command, mcp__plugin_vscode-agent-bridge_vscode__reload_window, mcp__plugin_vscode-agent-bridge_vscode__get_debug_output, mcp__plugin_vscode-agent-bridge_vscode__get_terminal_output
---

Operate VS Code using the explicit actions in `$ARGUMENTS`, left to right, each once. Perform only the requested actions; reject unknown actions or missing required options instead of guessing.

```text
/vscode problems --out /tmp/after.json --compare /tmp/before.json
/vscode reload problems --settle 5000 --out /tmp/problems.json
/vscode output --channel "Language Support for Java"
```

Select the target window with the `vscode` MCP tools (`list_windows`). If several windows could match, ask with `AskUserQuestion`. If none has a live bridge, say so and stop: the plugin's `SessionStart` hook installs the extension, and windows opened before that need one manual reload.

## `problems`

1. Call `get_diagnostics` with the window, `out` (default: a new `/tmp` path), and `min_count` (default `1`; for a known large workspace, derive a conservative threshold from the previous snapshot).
2. With `--compare <path>`, run `python3 <skill base directory>/scripts/compare-diagnostics.py <before> <after>`. Identity is the tuple `resource`, `startLineNumber`, `startColumn`, `severity`, `message`.
3. Report counts, the snapshot path, and exact removed/added counts. Build success is not diagnostic evidence.
4. `--settle <ms>` maps to `settle_ms`: wait until language servers stop publishing, bounded by `--timeout <seconds>` (default `120`). Pass it after `reload`, `java-clean`, or edits even when not given (default `5000`), since diagnostics are stale until servers finish. Report `settled: false` as a timeout, never as stability.
5. `--severity <error|warning|information|hint>` and `--resource <substring>` map to `min_severity` and `resource`; keep the unfiltered snapshot unless the user asked for a filtered file.

## `reload` and `java-clean`

- `reload`: `reload_window`. It waits for the new pid; with `settle_ms` it also returns settled diagnostics. When it returns `hostsThisSession: true`, confirm after the session resumes with `list_windows`.
- `java-clean`: only when explicitly requested. `execute_command` with `java.clean.workspace`; VS Code shows a confirmation the user must answer. Never delete workspace storage or kill VS Code/JDT processes.
- Neither implies up-to-date diagnostics; that needs `problems` with a settle wait.

## `debug-console`, `terminal`, `output`

- `debug-console`: `get_debug_output` (latest session by default; `session`, `category`). Only covers output since the bridge started. Do not start, stop, or evaluate in a debug session.
- `terminal`: `get_terminal_output` returns each shell-integrated command with its output and exit code. Only covers commands since the bridge started. Do not send keys or run commands in the user's terminal.
- `output --channel <exact-name>`: VS Code has no API for other extensions' Output channels. Read the channel's log file (for example under `~/Library/Application Support/Code/logs/<session>/window*/exthost/`) or the owning tool's report; otherwise ask the user to copy it.

State whether the result is complete or partial history.

## Safety

- Never modify source files, repository state, VS Code settings, or extension configuration.
- Treat command dispatch, reload, language-server stability, diagnostics export, and comparison as separate evidence. If an action cannot be proven, report failure.
