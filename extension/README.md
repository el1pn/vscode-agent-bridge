# VS Code Agent Bridge

Lets local coding agents use VS Code APIs without raising or focusing the window: diagnostics, any command, rename, file moves with import updates, call hierarchy, tasks, terminal output, and debugging.

This extension is only the VS Code half. Agents talk to it through the MCP server in [el1pn/vscode-agent-bridge](https://github.com/el1pn/vscode-agent-bridge); install that too (as a Claude Code plugin or a stdio MCP server for other clients).

## How it works

Each window listens on a random `127.0.0.1` port and writes `{pid, port, token, version, workspaceName, workspaceFile, folders}` to `~/.vscode-agent-bridge/<pid>.json` (mode `0600`). Requests must carry that token.

## Security

Any process running as the same user can read the token and run arbitrary VS Code commands. Install it only on machines you trust.

## License

MIT
