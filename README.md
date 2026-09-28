# VS Code Bridge

Localhost bridge that lets local automation read diagnostics and run VS Code commands without raising or focusing the window.

On activation, each window listens on a random `127.0.0.1` port and writes `{pid, port, token, workspaceName, workspaceFile, folders}` to `~/.vscode-bridge/<pid>.json` (mode `0600`). Requests need `Authorization: Bearer <token>`.

- `GET /diagnostics` — all diagnostics in Problems-panel JSON shape (`severity`: 8 error, 4 warning, 2 info, 1 hint).
- `POST /command` `{"command": "<id>", "args": [...]}` — runs any command; `workbench.action.reloadWindow` replies `202` before reloading.

Any process running as the same user can read the token and run arbitrary commands. Install only on machines you trust.

## Release

```sh
npx -y @vscode/vsce package --allow-missing-repository --skip-license
gh release create v<version> vscode-bridge-<version>.vsix
```
