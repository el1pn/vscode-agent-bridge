---
name: vscode
description: Inspect VS Code Problems, Output, Debug Console, or Terminal, reload the workbench, and manage JDT lifecycle through explicit independent actions
argument-hint: <problems|output|debug-console|terminal|reload|java-wait|java-clean> [action ...] [options]
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion, mcp__plugin_vscode-agent-bridge_vscode__list_windows, mcp__plugin_vscode-agent-bridge_vscode__get_diagnostics, mcp__plugin_vscode-agent-bridge_vscode__execute_command
---

Operate VS Code using the explicit actions in `$ARGUMENTS`, left to right, each once. Perform only the requested actions; reject unknown actions or missing required options instead of guessing.

```text
/vscode problems --out /tmp/after.json --compare /tmp/before.json
/vscode reload java-wait problems --out /tmp/problems.json
/vscode output --channel "Language Support for Java"
```

Select the target window with the `vscode` MCP tools (`list_windows`). If several windows could match, ask with `AskUserQuestion`. If none has a live bridge, say so and stop: the plugin's `SessionStart` hook installs the extension, and windows opened before that need one manual reload.

## `problems`

1. Call `get_diagnostics` with the window, `out` (default: a new `/tmp` path), and `min_count` (default `1`; for a known large workspace, derive a conservative threshold from the previous snapshot).
2. With `--compare <path>`, run `python3 <skill base directory>/scripts/compare-diagnostics.py <before> <after>`. Identity is the tuple `resource`, `startLineNumber`, `startColumn`, `severity`, `message`.
3. Report counts, the snapshot path, and exact removed/added counts. Build success is not diagnostic evidence.
4. Right after `reload` or `java-clean`, Java diagnostics may be stale until `java-wait` passes; say so if `java-wait` was not requested.

## `reload` and `java-clean`

- `reload`: `execute_command` with `workbench.action.reloadWindow`. Confirm by a new `pid` for that window in `list_windows`.
- `java-clean`: only when explicitly requested. `execute_command` with `java.clean.workspace`; VS Code shows a confirmation the user must answer. Never delete workspace storage or kill VS Code/JDT processes.
- Neither implies a stable language server; that needs `java-wait`.

## `java-wait`

Wait for the JDT Language Server to stabilize.

Options: `--storage <path>` (Red Hat Java workspace-storage dir; infer only when exactly one fits), `--expected-java <path-or-substring>`, `--timeout <seconds>` (default `120`).

Run `python3 <skill base directory>/scripts/wait-for-jdt.py --storage <path> [--expected-java <jdk>] --interval 2 --stable-checks 3 --timeout <s>`. It requires a live `org.eclipse.equinox.launcher` process and stable `jdt_ws`/`ss_ws` timestamps. On timeout, report failure; silence is not stability.

## `output`, `debug-console`, `terminal`

VS Code has no public API for other extensions' Output channels, Debug Console history, or terminal scrollback, so the bridge cannot read them.

- `output --channel <exact-name>`: read the channel's log file (for example under `~/Library/Application Support/Code/logs/<session>/window*/exthost/`) or the owning tool's report.
- `debug-console`: read the debugger's own log or captured Debug Adapter Protocol output. Do not start, stop, or evaluate in a debug session.
- `terminal`: prefer output of commands run through Bash or the process's own log. Do not send keys or run commands in the user's terminal.

If no file source exists, ask the user to copy the panel content rather than automating the UI. State whether the result is complete or partial history.

## Safety

- Never modify source files, repository state, VS Code settings, or extension configuration.
- Treat command dispatch, reload, language-server stability, diagnostics export, and comparison as separate evidence. If an action cannot be proven, report failure.
