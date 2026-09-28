// Localhost bridge so local agents can use VS Code APIs without raising the window.
const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { version } = require('./package.json');

const REGISTRY_DIR = path.join(os.homedir(), '.vscode-agent-bridge');
// Same numeric severities the Problems panel uses when copied as JSON.
const SEVERITY = { 0: 8, 1: 4, 2: 2, 3: 1 };
const MAX_DEBUG_SESSIONS = 10;
const MAX_DEBUG_CHARS = 1_000_000;
const MAX_EXECUTIONS = 50;
const MAX_EXECUTION_CHARS = 200_000;
// CSI and OSC escape sequences emitted by shells and shell integration.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

let server;
let registryFile;
const debugSessions = [];
const executions = [];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toUri(value) {
  return /^[a-z][\w+.-]*:\/\//i.test(value) ? vscode.Uri.parse(value) : vscode.Uri.file(value);
}

// JSON cannot carry VS Code types, so args use {$uri}, {$position: [line, column]} and
// {$range: [line, column, endLine, endColumn]}, all 1-based like the Problems panel.
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  if ('$uri' in value) return toUri(value.$uri);
  if ('$position' in value) {
    const [line, column] = value.$position;
    return new vscode.Position(line - 1, column - 1);
  }
  if ('$range' in value) {
    const [line, column, endLine, endColumn] = value.$range;
    return new vscode.Range(line - 1, column - 1, endLine - 1, endColumn - 1);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

function encode(value, seen = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return value;
  if (value instanceof vscode.Uri) return value.scheme === 'file' ? value.fsPath : value.toString();
  if (value instanceof vscode.Position) return { line: value.line + 1, column: value.character + 1 };
  if (value instanceof vscode.Range) return { start: encode(value.start), end: encode(value.end) };
  if (value instanceof vscode.MarkdownString) return value.value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) out = value.map((item) => encode(item, seen) ?? null);
  else if (value instanceof Map) out = [...value].map((entry) => encode(entry, seen));
  else {
    out = {};
    for (const [key, item] of Object.entries(value)) {
      const encoded = encode(item, seen);
      if (encoded !== undefined) out[key] = encoded;
    }
  }
  seen.delete(value);
  return out;
}

// Resolves true once diagnostics stop changing for quietMs, false if timeoutMs passes first.
function settle(quietMs, timeoutMs) {
  return new Promise((resolve) => {
    let quiet;
    const done = (settled) => {
      clearTimeout(quiet);
      clearTimeout(deadline);
      subscription.dispose();
      resolve(settled);
    };
    const deadline = setTimeout(done, timeoutMs, false);
    const subscription = vscode.languages.onDidChangeDiagnostics(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs, true);
    });
    quiet = setTimeout(done, quietMs, true);
  });
}

async function diagnostics({ minSeverity = 1, resource, settleMs = 0, timeoutMs = 120_000 }) {
  const settled = settleMs > 0 ? await settle(settleMs, timeoutMs) : null;
  const items = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    const file = uri.scheme === 'file' ? uri.fsPath : uri.toString();
    if (resource && !file.includes(resource)) continue;
    for (const d of list) {
      const severity = SEVERITY[d.severity];
      if (severity < minSeverity) continue;
      items.push({
        resource: file,
        owner: d.source ?? '',
        code: typeof d.code === 'object' ? String(d.code.value) : d.code,
        severity,
        message: d.message,
        source: d.source,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
      });
    }
  }
  return { settled, items };
}

async function command({ command: id, args = [] }) {
  if (typeof id !== 'string' || !Array.isArray(args)) throw new HttpError(400, 'command must be a string and args an array');
  // Reload tears down this host, so reply before running it.
  if (id === 'workbench.action.reloadWindow') {
    setTimeout(() => vscode.commands.executeCommand(id), 100);
    return { accepted: true };
  }
  return { result: encode(await vscode.commands.executeCommand(id, ...decode(args))) };
}

async function commands({ filter = '' }) {
  const all = (await vscode.commands.getCommands(true)).filter((id) => id.includes(filter)).sort();
  return { total: all.length, commands: all.slice(0, 500) };
}

function taskFolder(task) {
  return typeof task.scope === 'object' ? task.scope.uri.fsPath : null;
}

function describeTask(task) {
  return { name: task.name, source: task.source, folder: taskFolder(task), type: task.definition.type, group: task.group?.id ?? null };
}

async function tasks() {
  return (await vscode.tasks.fetchTasks()).map(describeTask);
}

async function runTask({ name, source, folder, timeoutMs = 600_000 }) {
  const matches = (await vscode.tasks.fetchTasks())
    .filter((t) => t.name === name && (!source || t.source === source) && (!folder || taskFolder(t) === folder));
  if (matches.length !== 1) throw new HttpError(400, `Expected one task named ${JSON.stringify(name)}, found ${matches.length}`);
  const task = matches[0];
  return new Promise((resolve, reject) => {
    const subscriptions = [];
    let execution;
    const finish = (result) => {
      clearTimeout(deadline);
      subscriptions.forEach((s) => s.dispose());
      resolve({ task: describeTask(task), ...result });
    };
    const deadline = setTimeout(() => finish({ exitCode: null, timedOut: true }), timeoutMs);
    subscriptions.push(
      vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === execution) finish({ exitCode: e.exitCode ?? null }); }),
      // Tasks without a process (e.g. custom execution) only fire onDidEndTask.
      vscode.tasks.onDidEndTask((e) => { if (e.execution === execution) setTimeout(() => finish({ exitCode: null }), 500); }),
    );
    vscode.tasks.executeTask(task).then((started) => { execution = started; }, (err) => {
      clearTimeout(deadline);
      subscriptions.forEach((s) => s.dispose());
      reject(err);
    });
  });
}

function trackDebugSession(session) {
  const record = { id: session.id, name: session.name, type: session.type, started: Date.now(), ended: null, chars: 0, output: [] };
  debugSessions.push(record);
  if (debugSessions.length > MAX_DEBUG_SESSIONS) debugSessions.shift();
  return {
    onDidSendMessage(message) {
      if (message.type !== 'event' || message.event !== 'output' || !message.body?.output) return;
      record.output.push({ category: message.body.category ?? 'console', text: message.body.output });
      record.chars += message.body.output.length;
      while (record.chars > MAX_DEBUG_CHARS && record.output.length > 1) {
        record.chars -= record.output.shift().text.length;
        record.truncated = true;
      }
    },
    onWillStopSession() { record.ended ??= Date.now(); },
    onExit() { record.ended ??= Date.now(); },
  };
}

function debugOutput({ session, category }) {
  const record = session
    ? debugSessions.findLast((r) => r.id === session || r.name === session)
    : debugSessions.at(-1);
  return {
    sessions: debugSessions.map(({ id, name, type, started, ended }) => ({ id, name, type, started, ended })),
    session: record ? { id: record.id, name: record.name, ended: record.ended, truncated: Boolean(record.truncated) } : null,
    output: record ? record.output.filter((o) => !category || o.category === category).map((o) => o.text).join('') : '',
  };
}

const executionRecords = new WeakMap();

function trackExecution(event) {
  // read() only yields data written after the call, so start reading immediately.
  const stream = event.execution.read();
  const record = {
    terminal: event.terminal.name,
    command: event.execution.commandLine.value,
    cwd: event.execution.cwd ? encode(event.execution.cwd) : null,
    started: Date.now(),
    ended: null,
    exitCode: null,
    truncated: false,
    output: '',
  };
  executionRecords.set(event.execution, record);
  executions.push(record);
  if (executions.length > MAX_EXECUTIONS) executions.shift();
  (async () => {
    for await (const data of stream) {
      record.output += data;
      if (record.output.length > MAX_EXECUTION_CHARS) {
        record.output = record.output.slice(-MAX_EXECUTION_CHARS);
        record.truncated = true;
      }
    }
  })().catch(() => {});
}

function endExecution(event) {
  const record = executionRecords.get(event.execution);
  if (!record) return;
  record.ended = Date.now();
  record.exitCode = event.exitCode ?? null;
}

function terminalOutput({ terminal, limit = 10 }) {
  return {
    terminals: vscode.window.terminals.map((t) => t.name),
    executions: executions
      .filter((r) => !terminal || r.terminal === terminal)
      .slice(-limit)
      .map((r) => ({ ...r, output: r.output.replace(ANSI, '') })),
  };
}

const ROUTES = {
  '/diagnostics': diagnostics,
  '/command': command,
  '/commands': commands,
  '/tasks': tasks,
  '/run-task': runTask,
  '/debug-output': debugOutput,
  '/terminal-output': terminalOutput,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new HttpError(400, 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: trackDebugSession }),
    vscode.window.onDidStartTerminalShellExecution(trackExecution),
    vscode.window.onDidEndTerminalShellExecution(endExecution),
  );

  const token = crypto.randomBytes(24).toString('hex');
  server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    const route = ROUTES[req.url];
    if (req.method !== 'POST' || !route) return send(404, { error: 'not found' });
    try {
      send(200, await route(await readBody(req)));
    } catch (err) {
      send(err instanceof HttpError ? err.status : 500, { error: String(err?.message ?? err) });
    }
  });

  server.listen(0, '127.0.0.1', () => {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    registryFile = path.join(REGISTRY_DIR, `${process.pid}.json`);
    const entry = {
      pid: process.pid,
      port: server.address().port,
      token,
      version,
      workspaceName: vscode.workspace.name ?? null,
      workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    };
    fs.writeFileSync(registryFile, JSON.stringify(entry), { mode: 0o600 });
  });
}

function deactivate() {
  try { if (registryFile) fs.unlinkSync(registryFile); } catch {}
  server?.close();
}

module.exports = { activate, deactivate };
