#!/usr/bin/env node
// MCP stdio server for the VS Code Agent Bridge extension. Never raises or focuses a window.
//
// Each VS Code window running el1pn.vscode-agent-bridge registers {pid, port, token, ...}
// in ~/.vscode-agent-bridge/<pid>.json; tools route requests to the selected window.
const { execFileSync } = require('child_process');
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

const ARGS_DESCRIPTION = 'Positional command arguments. VS Code types are written as {"$uri": "/abs/path or scheme://..."}, '
  + '{"$position": [line, column]} and {"$range": [line, column, endLine, endColumn]}, all 1-based. '
  + 'Results encode Uri as a path and Position as {line, column}, also 1-based.';

const TOOLS = [
  {
    name: 'list_windows',
    description: 'List VS Code windows with a live bridge (pid, version, workspaceName, workspaceFile, folders).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_diagnostics',
    description: 'Read diagnostics (Problems panel) of a VS Code window through the native API without focusing it. '
      + 'Returns counts by severity; writes the full array (resource, startLineNumber, startColumn, severity, message, ...) '
      + 'to `out` when given, otherwise returns it inline. Severity: 8 error, 4 warning, 2 information, 1 hint. '
      + 'Use settle_ms after a reload, clean, or edit to wait until language servers stop publishing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        out: { type: 'string', description: 'Absolute path for an atomic JSON snapshot.' },
        min_count: { type: 'integer', minimum: 0, description: 'Fail when fewer diagnostics are returned.' },
        min_severity: { type: 'integer', enum: [1, 2, 4, 8], description: 'Only return diagnostics at or above this severity.' },
        resource: { type: 'string', description: 'Only return diagnostics whose file path contains this substring.' },
        settle_ms: { type: 'integer', minimum: 0, description: 'Wait until diagnostics have not changed for this many ms. Result has settled: true, or false on timeout.' },
        timeout_ms: { type: 'integer', minimum: 0, description: 'Upper bound for settle_ms waiting; default 120000.' },
      },
    },
  },
  {
    name: 'execute_command',
    description: 'Run any VS Code command in a window without focusing it and return its result. Examples: '
      + 'workbench.action.reloadWindow, java.clean.workspace, vscode.executeDefinitionProvider, '
      + 'vscode.executeReferenceProvider, vscode.executeHoverProvider, vscode.executeDocumentSymbolProvider, '
      + 'vscode.executeWorkspaceSymbolProvider, vscode.open. Commands that open dialogs still need the user to answer them. '
      + 'Use reload_window instead of workbench.action.reloadWindow.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        command: { type: 'string', description: 'VS Code command ID.' },
        args: { type: 'array', description: ARGS_DESCRIPTION },
      },
      required: ['command'],
    },
  },
  {
    name: 'reload_window',
    description: 'Reload a VS Code window and wait until its bridge answers again with a new pid; with settle_ms, also wait '
      + 'for diagnostics to settle and return their counts (full array to `out`); the settle wait starts after the first '
      + 'diagnostics change or 30s, since restarted language servers publish late. If the window hosts this Claude Code '
      + 'session, returns {accepted: true, hostsThisSession: true} immediately: the session restarts and continues '
      + '(claudeCode.continueAfterReload, on by default); then confirm with list_windows. Refuses when other Claude Code '
      + 'sessions run in the window, because reloading stops their background subagents; pass force: true only after the user agreed.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        settle_ms: { type: 'integer', minimum: 0, description: 'After reload, wait until diagnostics have not changed for this many ms.' },
        timeout_ms: { type: 'integer', minimum: 0, description: 'Upper bound for the whole reload; default 120000.' },
        out: { type: 'string', description: 'With settle_ms: absolute path for the diagnostics snapshot.' },
        force: { type: 'boolean', description: 'Reload even though other Claude Code sessions run in the window. Only after the user agreed.' },
      },
    },
  },
  {
    name: 'list_commands',
    description: 'List VS Code command IDs available in a window (at most 500, sorted), optionally filtered by substring.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        filter: { type: 'string', description: 'Only return command IDs containing this substring.' },
      },
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks VS Code can run in a window (tasks.json and auto-detected tasks such as npm or gradle).',
    inputSchema: { type: 'object', properties: { workspace: WORKSPACE } },
  },
  {
    name: 'run_task',
    description: 'Run a VS Code task by name and wait for it to finish. Returns the exit code, or timedOut: true. '
      + 'Task output goes to its terminal; read it with get_terminal_output.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        name: { type: 'string', description: 'Task name from list_tasks.' },
        source: { type: 'string', description: 'Task source from list_tasks, when several tasks share a name.' },
        folder: { type: 'string', description: 'Task folder from list_tasks, for multi-root workspaces.' },
        timeout_ms: { type: 'integer', minimum: 0, description: 'Default 600000.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_debug_output',
    description: 'Read Debug Console output of a debug session in a window (latest session by default). '
      + 'Only output produced after the bridge started is available; each session keeps at most 1,000,000 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        session: { type: 'string', description: 'Debug session id or name; default is the latest session.' },
        category: { type: 'string', description: 'Only this output category, e.g. stdout, stderr, console.' },
      },
    },
  },
  {
    name: 'get_terminal_output',
    description: 'Read output of commands run in VS Code integrated terminals, per command with exit code. '
      + 'Needs shell integration and only covers commands started after the bridge started; '
      + 'keeps the last 50 commands and 200,000 characters each.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        terminal: { type: 'string', description: 'Terminal name; default is all terminals.' },
        limit: { type: 'integer', minimum: 1, description: 'Most recent commands to return; default 10.' },
      },
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

const summary = ({ pid, version, workspaceName, workspaceFile, folders }) => ({ pid, version: version ?? null, workspaceName, workspaceFile, folders });

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
function call(entry, route, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: entry.port,
      path: route,
      method: 'POST',
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
    req.end(JSON.stringify(body));
  });
}

async function getDiagnostics({
  workspace, out, min_count: minCount = 0, min_severity: minSeverity, resource, settle_ms: settleMs, timeout_ms: timeoutMs,
}, firstChangeMs) {
  const { settled, items } = await call(select(workspace), '/diagnostics', { minSeverity, resource, settleMs, timeoutMs, firstChangeMs });
  if (items.length < minCount) throw new ToolError(`Only ${items.length} diagnostics, below min_count ${minCount}`);
  const counts = Object.fromEntries(Object.values(SEVERITY_NAMES).map((name) => [name, 0]));
  for (const item of items) {
    const name = SEVERITY_NAMES[item.severity];
    if (name) counts[name] += 1;
  }
  const result = { total: items.length, ...counts, ...(settled === null ? {} : { settled }) };
  if (!out) return { ...result, diagnostics: items };
  if (!path.isAbsolute(out) || !fs.existsSync(path.dirname(out))) {
    throw new ToolError(`out must be an absolute path in an existing directory: ${out}`);
  }
  const tmp = `${out}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, out);
  return { ...result, saved: out };
}

function executeCommand({ command, workspace, args = [] } = {}) {
  if (typeof command !== 'string') throw new ToolError('command must be a string');
  if (command === 'workbench.action.reloadWindow') throw new ToolError('Use reload_window, which checks for other sessions in the window.');
  return call(select(workspace), '/command', { command, args });
}

// Stable across reloads, unlike pid; also accepted by select().
const windowKey = (e) => e.workspaceFile ?? e.folders?.[0] ?? e.workspaceName;
const FIRST_CHANGE_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ponytail: POSIX ps only. On Windows this returns an empty table, so reload_window neither detects the
// hosting session nor blocks on other agents; add a Windows process listing before supporting it there.
function processTable() {
  let text = '';
  try {
    text = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return new Map();
  }
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
  }
  return table;
}

function ancestors(table, pid) {
  const chain = [];
  for (let current = pid; current > 1 && table.has(current) && !chain.includes(current);) {
    chain.push(current);
    current = table.get(current).ppid;
  }
  return chain;
}

// Claude Code sessions whose process descends from the extension host; background subagents run inside them.
function agentsInWindow(hostPid) {
  const table = processTable();
  const mine = new Set(ancestors(table, process.ppid));
  const hostsThisSession = mine.has(hostPid);
  const others = [];
  for (const [pid, { command }] of table) {
    if (mine.has(pid) || !/(^|\/)claude(\s|$)/.test(command.split(' --')[0])) continue;
    if (ancestors(table, pid).includes(hostPid)) others.push(pid);
  }
  return { hostsThisSession, others };
}

async function reloadWindow({ workspace, settle_ms: settleMs, timeout_ms: timeoutMs = 120_000, out, force = false } = {}) {
  const before = select(workspace);
  const key = windowKey(before);
  const { hostsThisSession, others } = agentsInWindow(before.pid);
  if (others.length && !force) {
    throw new ToolError(`Window ${JSON.stringify(key)} hosts ${others.length} other Claude Code session(s) (pid ${others.join(', ')}). `
      + 'Reloading restarts them and stops their running background subagents, which do not resume on their own. '
      + 'Ask the user, then retry with force: true.');
  }
  await call(before, '/command', { command: 'workbench.action.reloadWindow' });
  // This process dies with the window, so waiting would never return.
  if (hostsThisSession) return { accepted: true, oldPid: before.pid, hostsThisSession: true };
  const deadline = Date.now() + timeoutMs;
  // The extension host may restart more than once, so require the same new pid to answer twice.
  let candidate = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const entry = windows().find((e) => windowKey(e) === key && e.pid !== before.pid);
    if (!entry) { candidate = null; continue; }
    try {
      await call(entry, '/commands', { filter: '\u0000' }); // cheap liveness probe: matches no command
    } catch {
      candidate = null;
      continue;
    }
    if (candidate?.pid === entry.pid) {
      const result = { oldPid: before.pid, newPid: entry.pid, version: entry.version ?? null };
      if (!settleMs) return result;
      // Language servers restart with the host and may publish nothing for a while; don't mistake that for settled.
      const diagnostics = await getDiagnostics(
        { workspace: key, settle_ms: settleMs, timeout_ms: Math.max(deadline - Date.now(), 1), out },
        Math.min(FIRST_CHANGE_MS, deadline - Date.now()),
      );
      return { ...result, diagnostics };
    }
    candidate = entry;
  }
  throw new ToolError(`Window ${JSON.stringify(key)} did not come back within ${timeoutMs} ms`);
}

const HANDLERS = {
  list_windows: () => windows().map(summary),
  get_diagnostics: (args = {}) => getDiagnostics(args),
  execute_command: executeCommand,
  reload_window: reloadWindow,
  list_commands: ({ workspace, filter } = {}) => call(select(workspace), '/commands', { filter }),
  list_tasks: ({ workspace } = {}) => call(select(workspace), '/tasks'),
  run_task: ({ workspace, name, source, folder, timeout_ms: timeoutMs } = {}) => {
    if (typeof name !== 'string') throw new ToolError('name must be a string');
    return call(select(workspace), '/run-task', { name, source, folder, timeoutMs });
  },
  get_debug_output: ({ workspace, session, category } = {}) => call(select(workspace), '/debug-output', { session, category }),
  get_terminal_output: ({ workspace, terminal, limit } = {}) => call(select(workspace), '/terminal-output', { terminal, limit }),
};

// Returns the JSON-RPC result, or undefined for an unknown method.
async function handle({ method, params = {} }) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'vscode-agent-bridge', version: '3.3.0' },
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

module.exports = { config, handle, HANDLERS, agentsInWindow };
