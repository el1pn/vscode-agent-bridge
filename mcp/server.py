#!/usr/bin/env python3
"""MCP stdio server for the VS Code Agent Bridge extension. Never raises or focuses a window.

Each VS Code window running el1pn.vscode-agent-bridge registers {pid, port, token, ...}
in ~/.vscode-agent-bridge/<pid>.json; tools route requests to the selected window.
"""
import json
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.request

REGISTRY = pathlib.Path.home() / ".vscode-agent-bridge"
SEVERITY_NAMES = {8: "errors", 4: "warnings", 2: "information", 1: "hints"}
WORKSPACE = {
    "type": "string",
    "description": "workspaceName, workspaceFile, or a folder path from list_windows. Optional when exactly one window is running.",
}

TOOLS = [
    {
        "name": "list_windows",
        "description": "List VS Code windows with a live bridge (pid, workspaceName, workspaceFile, folders).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_diagnostics",
        "description": "Read all diagnostics (Problems panel) of a VS Code window through the native API without focusing it. "
        "Returns counts by severity; writes the full array (resource, startLineNumber, startColumn, severity, message, ...) "
        "to `out` when given, otherwise returns it inline. Severity: 8 error, 4 warning, 2 information, 1 hint.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace": WORKSPACE,
                "out": {"type": "string", "description": "Absolute path for an atomic JSON snapshot."},
                "min_count": {"type": "integer", "minimum": 0, "description": "Fail when fewer diagnostics are returned."},
            },
        },
    },
    {
        "name": "execute_command",
        "description": "Run a VS Code command in a window without focusing it, e.g. workbench.action.reloadWindow or "
        "java.clean.workspace. Commands that open dialogs still need the user to answer them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace": WORKSPACE,
                "command": {"type": "string", "description": "VS Code command ID."},
                "args": {"type": "array", "description": "Positional command arguments."},
            },
            "required": ["command"],
        },
    },
]


class ToolError(Exception):
    pass


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def windows():
    found = []
    for path in REGISTRY.glob("*.json"):
        try:
            entry = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(entry, dict) or not {"pid", "port", "token"} <= entry.keys():
            continue
        if alive(entry["pid"]):
            found.append(entry)
        else:
            path.unlink(missing_ok=True)
    return found


def public(entry):
    return {k: entry.get(k) for k in ("pid", "workspaceName", "workspaceFile", "folders")}


def select(workspace):
    candidates = windows()
    if not candidates:
        raise ToolError("No VS Code Agent Bridge is running. Start a new Claude session to install it, then reload VS Code.")
    if workspace:
        candidates = [
            e for e in candidates
            if workspace in (e.get("workspaceName"), e.get("workspaceFile")) or workspace in e.get("folders", [])
        ]
    if len(candidates) != 1:
        names = [e.get("workspaceName") for e in windows()]
        raise ToolError(f"Expected one window for workspace {workspace!r}; available: {names}")
    return candidates[0]


def call(entry, method, route, body=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{entry['port']}{route}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {entry['token']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        raise ToolError(f"Bridge error {err.code}: {err.read().decode()}")
    except urllib.error.URLError as err:
        raise ToolError(f"Bridge unreachable: {err.reason}")


def get_diagnostics(workspace=None, out=None, min_count=0):
    data = call(select(workspace), "GET", "/diagnostics")
    if len(data) < min_count:
        raise ToolError(f"Only {len(data)} diagnostics, below min_count {min_count}")
    counts = {name: 0 for name in SEVERITY_NAMES.values()}
    for item in data:
        name = SEVERITY_NAMES.get(item.get("severity"))
        if name:
            counts[name] += 1
    result = {"total": len(data), **counts}
    if not out:
        return {**result, "diagnostics": data}
    target = pathlib.Path(out)
    if not target.is_absolute() or not target.parent.is_dir():
        raise ToolError(f"out must be an absolute path in an existing directory: {out}")
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=target.name + ".tmp.")
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, target)
    return {**result, "saved": str(target)}


def execute_command(command, workspace=None, args=None):
    return call(select(workspace), "POST", "/command", {"command": command, "args": args or []})


HANDLERS = {
    "list_windows": lambda: [public(e) for e in windows()],
    "get_diagnostics": get_diagnostics,
    "execute_command": execute_command,
}


def handle(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "vscode-agent-bridge", "version": "2.0.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        try:
            value = HANDLERS[params["name"]](**(params.get("arguments") or {}))
            return {"content": [{"type": "text", "text": json.dumps(value, indent=2)}]}
        except (ToolError, KeyError, TypeError) as err:
            return {"content": [{"type": "text", "text": str(err)}], "isError": True}
    raise LookupError(method)


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        message = json.loads(line)
        if "id" not in message:
            continue  # notifications need no reply
        try:
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
        except LookupError:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Method not found"}}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
