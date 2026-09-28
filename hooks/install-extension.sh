#!/usr/bin/env bash
# Build and install the bundled VS Code extension when the installed version is missing or stale.
set -u

command -v code >/dev/null 2>&1 || exit 0
src="${CLAUDE_PLUGIN_ROOT:?}/extension"
version=$(node -p 'require(process.argv[1]).version' "$src/package.json") || exit 0

installed=$(code --list-extensions --show-versions 2>/dev/null | sed -n 's/^el1pn\.vscode-agent-bridge@//p')
# Only upgrade: an older plugin cache (another session) must not replace a newer install.
[[ -n "$installed" && "$(printf '%s\n%s\n' "$installed" "$version" | sort -V | tail -1)" == "$installed" ]] && exit 0

dir=$(mktemp -d)
cd "$src" \
  && npx -y @vscode/vsce package --allow-missing-repository --skip-license -o "$dir/extension.vsix" >/dev/null 2>&1 \
  && code --install-extension "$dir/extension.vsix" --force >/dev/null 2>&1 \
  && echo "VS Code Agent Bridge $version installed; reload VS Code windows to activate it."
rm -rf "$dir"
