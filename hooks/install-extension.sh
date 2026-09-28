#!/usr/bin/env bash
# Build and install the bundled VS Code extension when the installed version is missing or stale.
set -u

command -v code >/dev/null 2>&1 || exit 0
src="${CLAUDE_PLUGIN_ROOT:?}/extension"
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$src/package.json") || exit 0

code --list-extensions --show-versions 2>/dev/null | grep -qx "el1pn.vscode-agent-bridge@$version" && exit 0

dir=$(mktemp -d)
cd "$src" \
  && npx -y @vscode/vsce package --allow-missing-repository --skip-license -o "$dir/extension.vsix" >/dev/null 2>&1 \
  && code --install-extension "$dir/extension.vsix" --force >/dev/null 2>&1 \
  && echo "VS Code Agent Bridge $version installed; reload VS Code windows to activate it."
rm -rf "$dir"
