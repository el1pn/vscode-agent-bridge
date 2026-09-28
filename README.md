# VS Code Agent Bridge

Lets local agents read VS Code diagnostics and run VS Code commands without raising or focusing the window. It is packaged as a Claude Code plugin and contains:

- `extension/`: a VS Code extension. Each window listens on a random `127.0.0.1` port and writes `{pid, port, token, version, workspaceName, workspaceFile, folders}` to `~/.vscode-agent-bridge/<pid>.json` (mode `0600`). All routes are `POST` with a JSON body:
  - `/diagnostics` `{minSeverity, resource, settleMs, timeoutMs}`: diagnostics in Problems-panel JSON shape (`severity`: 8 error, 4 warning, 2 information, 1 hint), optionally after they stop changing.
  - `/command` `{command, args}`: runs any command. Args use `{$uri}`, `{$position: [line, column]}`, `{$range: [...]}` (1-based); results encode VS Code types back to JSON. `workbench.action.reloadWindow` replies `{accepted: true}` before reloading.
  - `/commands` `{filter}`, `/tasks`, `/run-task` `{name, source, folder, timeoutMs}`.
  - `/debug-output` `{session, category}`: Debug Console output captured by a debug adapter tracker.
  - `/terminal-output` `{terminal, limit}`: per-command output and exit code captured through shell integration.
- `mcp/server.js`: a stdio MCP server (Node.js built-ins only) exposing those routes as tools. It routes each call to the selected window.
- `skills/vscode`: the `/vscode` skill. It drives the MCP tools, waits for the JDT language server, compares diagnostics snapshots, and reads Output channels from log files.
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
| Linux | Untested; code is POSIX-only | `wait-for-jdt.py` uses `ps -axo` (BSD form) |
| Windows | Untested | MCP server is Node and cross-platform; remaining gaps: bash hook, `ps` in `wait-for-jdt.py` |
| Codex / Gemini / OpenCode | Manual setup | No stable server path outside the Claude plugin cache; the `execute_command` reload note assumes Claude Code's `continueAfterReload` |
| VS Code Remote (SSH/WSL/containers) | Unsupported | Extension runs remotely and writes its registry there |
| Cursor / Windsurf / VSCodium | Untested | The hook installs through `code` only |

## Develop

- Self-check: `node --test mcp/server.test.js`
- When `extension/` changes, bump `extension/package.json` `version` so the hook reinstalls it, and bump `.claude-plugin/plugin.json` `version` so `claude plugin update` picks up the change.
