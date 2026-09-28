---
name: vscode
description: Inspect VS Code Problems, Output, Debug Console, or Terminal, reload the workbench, and manage JDT lifecycle through explicit independent actions
argument-hint: <problems|output|debug-console|terminal|reload|java-wait|java-clean> [action ...] [options]
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion, mcp__plugin_vscode-agent-bridge_vscode__list_windows, mcp__plugin_vscode-agent-bridge_vscode__get_diagnostics, mcp__plugin_vscode-agent-bridge_vscode__execute_command
---

Operate VS Code using the explicit actions in `$ARGUMENTS`.

## Dispatch

- Require at least one action.
- Supported actions:
  - `problems`
  - `output`
  - `debug-console`
  - `terminal`
  - `reload`
  - `java-wait`
  - `java-clean`
- Perform only explicitly requested actions. Never infer or append another action.
- Execute multiple actions once, from left to right.
- Reject unknown actions, missing required options, or ambiguous ordering instead of guessing.

Examples:

```text
/vscode problems
/vscode problems --out /tmp/problems.json
/vscode problems --out /tmp/after.json --compare /tmp/before.json
/vscode output --channel "Language Support for Java"
/vscode debug-console
/vscode terminal
/vscode reload
/vscode java-wait
/vscode java-clean
/vscode reload java-wait problems --out /tmp/problems.json
```

## Data-source priority

Use the most reliable source available for each request:

1. Native VS Code API through the agent bridge.
2. Canonical log, report, or state file.
3. Owning CLI or debugger protocol.
4. Accessibility/UI copy.
5. Screenshot/OCR only for locating UI elements, never as primary evidence.

Do not read a panel through UI when a canonical CLI, report, or log already provides the requested data.

## Agent bridge (preferred, focus-free)

This plugin bundles the `el1pn.vscode-agent-bridge` extension (`${CLAUDE_PLUGIN_ROOT}/extension`), which serves native VS Code APIs on `127.0.0.1` with a per-window token registered in `~/.vscode-agent-bridge/<pid>.json`. It never raises windows, sends keystrokes, or touches the clipboard. The plugin's `SessionStart` hook installs or updates it; windows opened before installation need one manual reload.

The plugin's `vscode` MCP server exposes it as tools:

- `mcp__plugin_vscode-agent-bridge_vscode__list_windows` — windows with a live bridge (`workspaceName`, `workspaceFile`, `folders`).
- `mcp__plugin_vscode-agent-bridge_vscode__get_diagnostics` — `workspace`, optional `out`, `min_count`.
- `mcp__plugin_vscode-agent-bridge_vscode__execute_command` — `workspace`, `command`, optional `args`.

Use these for `problems` (`get_diagnostics`), `reload` (`workbench.action.reloadWindow`), and `java-clean` (`java.clean.workspace`, which still shows a confirmation prompt the user must answer). Fall back to the AppleScript/UI path below only when `list_windows` shows no matching window, and tell the user that path will steal focus.

## Shared window selection

Use `scripts/list-windows.applescript` to enumerate VS Code windows.

1. Prefer an exact title supplied by the user.
2. Otherwise match the current workspace name and `(Workspace)` suffix; ignore the changing editor/file prefix.
3. If exactly one window matches, use it.
4. If multiple windows match, ask the user to select one with `AskUserQuestion`.
5. If none match, report available titles and stop.
6. Raise the selected window and make the Code process frontmost before any UI action.

## Action: `problems`

Cross-language diagnostic export. Do not reload, clean, or wait for a language server unless those actions were supplied separately.

Options:

- `--out <absolute-path>`: validated destination snapshot.
- `--compare <absolute-path>`: prior snapshot for exact comparison.
- `--min-count <number>`: minimum plausible count; default `1`. For a known large workspace, derive a conservative threshold from the previous snapshot rather than accepting one marker.
- `--source <name>` or `--resource <substring>`: optional reporting filters; retain the unfiltered snapshot unless the user explicitly requests a filtered file.

Process:

1. If VS Code Bridge is running for the window, use `get_diagnostics` first.
2. Otherwise call `scripts/export-problems.sh` with the exact selected window title, output path, minimum count, and at most three attempts.
3. The helper must preserve and restore the clipboard, validate before saving, reject partial exports, and write snapshots atomically.
4. Diagnostics must be a JSON array whose entries contain:
   - `resource`
   - `startLineNumber`
   - `startColumn`
   - `severity`
   - `message`
5. Interpret VS Code numeric severities as `8=error`, `4=warning`, `2=information`, and `1=hint`.
6. For `--compare`, call `scripts/compare-diagnostics.py`. Exact identity is the complete five-field tuple above.
7. Report total counts and exact removed/added counts. Do not use build success as diagnostic evidence.
8. If no `--out` is supplied, report the validated temporary candidate path.

## Action: `output`

Inspect one VS Code Output channel. Require `--channel <exact-name>`.

1. Prefer the channel's canonical log file when known. Examples include language-server client logs and extension host logs.
2. Prefer an owning CLI/report when it represents the same requested data.
3. Otherwise raise the Output panel, select the exact channel, select all channel text, and copy it through UI automation while preserving the clipboard.
4. State whether the result came from a complete log file or only current UI history.
5. Never claim UI history is complete if the channel truncates or virtualizes old output.
6. Do not clear the channel.

## Action: `debug-console`

Inspect current Debug Console output only.

1. Prefer an existing debugger log or captured Debug Adapter Protocol output.
2. Otherwise use UI focus/select/copy with clipboard preservation.
3. State that public VS Code APIs do not expose arbitrary prior Debug Console history and that UI output may be partial.
4. Do not start, stop, restart, or continue a debug session unless separately requested.
5. Do not evaluate expressions in the debug session merely to read output.

## Action: `terminal`

Inspect an existing VS Code terminal only.

1. Prefer output from a command already run through the Bash tool or the process's canonical log.
2. Use terminal UI copy only for a terminal owned by the user or another extension whose output is otherwise unavailable.
3. If multiple terminals exist, ask which terminal to inspect.
4. Report that copied terminal scrollback may be truncated.
5. Do not run commands, send keys, stop processes, or clear the terminal under this action.

## Action: `reload`

Reload the VS Code workbench only.

1. Record current window title and, when relevant, language-server process/log timestamps.
2. Invoke `Developer: Reload Window` with `scripts/run-command.applescript`.
3. Re-enumerate windows after reload because the title prefix may change.
4. Confirm the workbench returned.
5. Do not claim any language server is stable; use an explicit language-specific wait action such as `java-wait`.
6. Do not export panels unless a later action requests it.

## Action: `java-wait`

Wait for JDT Language Server stabilization only.

Options:

- `--storage <absolute-path>`: Red Hat Java workspace-storage directory. Infer it only when exactly one relevant workspace storage is identifiable.
- `--expected-java <path-or-substring>`: expected JDK executable.
- `--timeout <seconds>`: default `120`.

Process:

1. Locate the active `org.eclipse.equinox.launcher` JDT process.
2. Verify the Java executable matches project requirements when known.
3. Call `scripts/wait-for-jdt.py` with a 2-second interval and three consecutive stable checks.
4. Require a matching JDT process and stable `jdt_ws`/`ss_ws` metadata timestamps.
5. On timeout, report failure. Silence or command completion is not evidence of stability.
6. Report process information and final timestamps.

## Action: `java-clean`

Clean JDT workspace state only.

1. Run only when explicitly requested.
2. Invoke `Java: Clean Java Language Server Workspace` in the selected window.
3. Handle the visible confirmation/restart flow.
4. Do not delete Red Hat Java workspace-storage directories manually.
5. Do not kill VS Code or JDT processes.
6. Do not wait for stabilization unless `java-wait` is also supplied.
7. Do not export Problems unless `problems` is also supplied.
8. Report that the action invalidated JDT workspace state and triggered a full rebuild only when UI/process evidence confirms it.

## Safety and evidence

- Never modify source files, repository state, VS Code settings, extension configuration, or language-server configuration.
- Preserve the user's clipboard on every UI-copy path, including failures.
- Never print clipboard content unrelated to the requested panel.
- Treat command dispatch, workbench reload, language-server stabilization, panel export, and exact comparison as separate evidence.
- If automation cannot prove an action succeeded, report failure rather than guessing.
