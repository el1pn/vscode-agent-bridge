# VS Code Agent Bridge

Lets local agents read VS Code diagnostics and run VS Code commands without raising or focusing the window. It is packaged as a Claude Code plugin and contains:

- `extension/`: a VS Code extension. Each window listens on a random `127.0.0.1` port and writes `{pid, port, token, version, workspaceName, workspaceFile, folders}` to `~/.vscode-agent-bridge/<pid>.json` (mode `0600`). All routes are `POST` with a JSON body.
- `mcp/server.js`: a stdio MCP server (Node.js built-ins only) that routes each tool call to the selected window:
  - Windows: `list_windows`, `reload_window` (waits for the new extension host; refuses without `force` when other Claude Code sessions run in the window, since reloading stops their background subagents).
  - Diagnostics: `get_diagnostics` — one line per item, settle wait, severity/resource/source filters, `open` to analyze unopened files, `out` snapshots and `since` diffs.
  - Code: `execute_command` (any command; `{$uri}`, `{$symbol}`, `{$position}`, `{$range}` args; compact text for locations, symbols, outlines, hovers; truncated at `max_chars`), `list_commands`, `rename_symbol`, `move_file` (updates imports), `call_hierarchy`.
  - Tasks and terminals: `list_tasks`, `run_task`, `get_terminal_output`.
  - Debugging: `debug_status`, `debug_start`, `debug_stop`, `debug_breakpoints`, `debug_control` (steps wait for the next stop), `debug_inspect`, `get_debug_output`.
  - Code is located by symbol name plus optional line or snippet; ambiguous names return the candidates instead of guessing.
- `skills/vscode`: the `/vscode` skill. It drives the MCP tools, compares diagnostics snapshots, and reads Output channels from log files.
- `hooks/`: on `SessionStart`, builds and installs the extension when the installed version is missing or stale.

## Security

Any process running as the same user can read the token and run arbitrary VS Code commands. Install it only on machines you trust.

## Install

Claude Code: install the `vscode-agent-bridge` plugin from the `el1pn` marketplace. Reload VS Code windows once after the extension is first installed.

Other MCP clients: install the extension (VS Code 1.93 or later) (`cd extension && npx -y @vscode/vsce package --allow-missing-repository --skip-license && code --install-extension *.vsix`), then register `node <repo>/mcp/server.js` as a stdio server.

## Support

Support is added per platform and per agent when needed, not through one abstraction for all of them.

| Target | Status | Gap to close |
|---|---|---|
| macOS + Claude Code (VS Code extension) | Supported, tested | — |
| Linux | Untested | Registry path and hook assume a POSIX shell, which Linux has |
| Windows | Untested | Install hook is bash; `compare-diagnostics.py` needs Python; `reload_window` session detection uses `ps` |
| Codex / Gemini / OpenCode | Manual setup | No stable server path outside the Claude plugin cache; the `execute_command` reload note assumes Claude Code's `continueAfterReload` |
| VS Code Remote (SSH/WSL/containers) | Unsupported | Extension runs remotely and writes its registry there |
| Cursor / Windsurf / VSCodium | Untested | The hook installs through `code` only |

## Develop

- Self-check: `node --test mcp/server.test.js`
- When `extension/` changes, bump `extension/package.json` `version` so the hook reinstalls it, and bump `.claude-plugin/plugin.json` `version` so `claude plugin update` picks up the change.
