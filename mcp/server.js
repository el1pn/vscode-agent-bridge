#!/usr/bin/env node
// MCP stdio server for the VS Code Agent Bridge extension. Never raises or focuses a window.
//
// Each VS Code window running el1pn.vscode-agent-bridge registers {pid, port, token, ...}
// in ~/.vscode-agent-bridge/<pid>.json; tools route requests to the selected window.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const config = { registry: path.join(os.homedir(), '.vscode-agent-bridge') };
const SEVERITY_NAMES = { 8: 'errors', 4: 'warnings', 2: 'information', 1: 'hints' };
const WORKSPACE = {
  type: 'string',
  description: 'workspaceName, workspaceFile, or a folder path from list_windows. Optional when exactly one window is running.',
};

const TOOLS = [
  {
    name: 'list_windows',
    description: 'List VS Code windows with a live bridge (pid, workspaceName, workspaceFile, folders).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_diagnostics',
    description: 'Read all diagnostics (Problems panel) of a VS Code window through the native API without focusing it. '
      + 'Returns counts by severity; writes the full array (resource, startLineNumber, startColumn, severity, message, ...) '
      + 'to `out` when given, otherwise returns it inline. Severity: 8 error, 4 warning, 2 information, 1 hint.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        out: { type: 'string', description: 'Absolute path for an atomic JSON snapshot.' },
        min_count: { type: 'integer', minimum: 0, description: 'Fail when fewer diagnostics are returned.' },
      },
    },
  },
  {
    name: 'execute_command',
    description: 'Run a VS Code command in a window without focusing it, e.g. workbench.action.reloadWindow or '
      + 'java.clean.workspace. Commands that open dialogs still need the user to answer them. '
      + 'workbench.action.reloadWindow returns {accepted: true} before reloading and works on the window hosting '
      + 'this Claude Code session: the VS Code extension restores the session and continues '
      + '(claudeCode.continueAfterReload, on by default). Confirm a reload by a new pid in list_windows.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        command: { type: 'string', description: 'VS Code command ID.' },
        args: { type: 'array', description: 'Positional command arguments.' },
      },
      required: ['command'],
    },
  },
];

class ToolError extends Error {}

// Signal 0 only tests existence, on Windows too (libuv checks the exit code instead of terminating).
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function windows() {
  let files;
  try {
    files = fs.readdirSync(config.registry).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found = [];
  for (const name of files) {
    const file = path.join(config.registry, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || !['pid', 'port', 'token'].every((key) => key in entry)) continue;
    if (alive(entry.pid)) found.push(entry);
    else fs.rmSync(file, { force: true });
  }
  return found;
}

const summary = ({ pid, workspaceName, workspaceFile, folders }) => ({ pid, workspaceName, workspaceFile, folders });

function select(workspace) {
  let candidates = windows();
  if (!candidates.length) {
    throw new ToolError('No VS Code Agent Bridge is running. Start a new Claude session to install it, then reload VS Code.');
  }
  if (workspace) {
    candidates = candidates.filter((e) => workspace === e.workspaceName || workspace === e.workspaceFile
      || (e.folders ?? []).includes(workspace));
  }
  if (candidates.length !== 1) {
    const names = windows().map((e) => e.workspaceName);
    throw new ToolError(`Expected one window for workspace ${JSON.stringify(workspace ?? null)}; available: ${JSON.stringify(names)}`);
  }
  return candidates[0];
}

// node:http instead of fetch: fetch's 300s header timeout would cut off long commands.
function call(entry, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: entry.port,
      path: route,
      method,
      timeout: 600_000,
      headers: { Authorization: `Bearer ${entry.token}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new ToolError(`Bridge error ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch { reject(new ToolError(`Bridge returned invalid JSON: ${text}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(err instanceof ToolError ? err : new ToolError(`Bridge unreachable: ${err.message}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function getDiagnostics({ workspace, out, min_count: minCount = 0 } = {}) {
  const data = await call(select(workspace), 'GET', '/diagnostics');
  if (data.length < minCount) throw new ToolError(`Only ${data.length} diagnostics, below min_count ${minCount}`);
  const counts = Object.fromEntries(Object.values(SEVERITY_NAMES).map((name) => [name, 0]));
  for (const item of data) {
    const name = SEVERITY_NAMES[item.severity];
    if (name) counts[name] += 1;
  }
  const result = { total: data.length, ...counts };
  if (!out) return { ...result, diagnostics: data };
  if (!path.isAbsolute(out) || !fs.existsSync(path.dirname(out))) {
    throw new ToolError(`out must be an absolute path in an existing directory: ${out}`);
  }
  const tmp = `${out}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, out);
  return { ...result, saved: out };
}

function executeCommand({ command, workspace, args = [] } = {}) {
  if (typeof command !== 'string') throw new ToolError('command must be a string');
  return call(select(workspace), 'POST', '/command', { command, args });
}

const HANDLERS = {
  list_windows: () => windows().map(summary),
  get_diagnostics: getDiagnostics,
  execute_command: executeCommand,
};

// Returns the JSON-RPC result, or undefined for an unknown method.
async function handle({ method, params = {} }) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'vscode-agent-bridge', version: '2.2.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    try {
      const handler = HANDLERS[params.name];
      if (!handler) throw new ToolError(`Unknown tool: ${params.name}`);
      const value = await handler(params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
  }
  return undefined;
}

function main() {
  const send = (reply) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...reply })}\n`);
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!('id' in message)) return; // notifications need no reply
    try {
      const result = await handle(message);
      send(result === undefined
        ? { id: message.id, error: { code: -32601, message: 'Method not found' } }
        : { id: message.id, result });
    } catch (err) {
      send({ id: message.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
}

if (require.main === module) main();

module.exports = { config, handle, HANDLERS };
