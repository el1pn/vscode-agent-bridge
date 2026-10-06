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
- `hooks/`: on `SessionStart`, builds and installs the extension when the installed version is missing or stale.

## Security

Any process running as the same user can read the token and run arbitrary VS Code commands. Install it only on machines you trust.

## Install

Requirements: VS Code 1.93 or later with the `code` command on `PATH` (on macOS, run "Shell Command: Install 'code' command in PATH"), and Node.js with `npx`.

### Claude Code

```sh
claude plugin marketplace add el1pn/vscode-agent-bridge
claude plugin install vscode-agent-bridge@vscode-agent-bridge
```

Start a new Claude Code session: its `SessionStart` hook builds and installs the extension in the background. Then reload each open VS Code window once (Developer: Reload Window). `claude mcp list` should show `plugin:vscode-agent-bridge:vscode` as connected, and the `list_windows` tool should list your windows.

Update with `claude plugin update vscode-agent-bridge@vscode-agent-bridge`; when the extension changes, the next session upgrades it and you reload the windows.

### Other MCP clients

Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=el1pn.vscode-agent-bridge), then clone the repository for the MCP server:

```sh
code --install-extension el1pn.vscode-agent-bridge
git clone https://github.com/el1pn/vscode-agent-bridge.git
```

Register `node /absolute/path/to/vscode-agent-bridge/mcp/server.js` as a stdio server, for example in Codex `~/.codex/config.toml`:

```toml
[mcp_servers.vscode]
command = "node"
args = ["/absolute/path/to/vscode-agent-bridge/mcp/server.js"]
```

Reload open VS Code windows once. VS Code updates the extension; pull to update the MCP server. Reloading the window that hosts the agent may stop it, since resuming after a reload is a Claude Code feature.

## Support

Support is added per platform and per agent when needed, not through one abstraction for all of them.

| Target | Status | Gap to close |
|---|---|---|
| macOS + Claude Code (VS Code extension) | Supported, tested | — |
| Linux | Untested | Registry path and hook assume a POSIX shell, which Linux has |
| Windows | Untested | Not yet verified end-to-end on a live Windows session; install hook needs Git Bash on `PATH` |
| Codex / Gemini / OpenCode | Manual setup, untested | Setup from a clone (see Install); the `reload_window` session note assumes Claude Code's `continueAfterReload` |
| VS Code Remote (SSH/WSL/containers) | Unsupported | Extension runs remotely and writes its registry there |
| Cursor / Windsurf / VSCodium | Untested | The hook installs through `code` only |

## Develop

- Self-check: `node --test mcp/server.test.js`
- When `extension/` changes, bump `extension/package.json` `version` so the hook reinstalls it, and bump `.claude-plugin/plugin.json` `version` so `claude plugin update` picks up the change. Then publish to the Marketplace: `cd extension && npx -y @vscode/vsce package` and upload the `.vsix` at https://marketplace.visualstudio.com/manage (Update).

## License

MIT

