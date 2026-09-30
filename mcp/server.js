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
const SEVERITY_LABELS = { 8: 'ERROR', 4: 'WARN', 2: 'INFO', 1: 'HINT' };
const IDENTITY = ['resource', 'startLineNumber', 'startColumn', 'severity', 'message'];
const DEFAULT_MAX_RESULTS = 200;

const WORKSPACE = {
  type: 'string',
  description: 'workspaceName, workspaceFile, or a folder path from list_windows. Optional when exactly one window is running.',
};
// Shared way to point at code: by symbol name (preferred) or by 1-based line/column.
const LOCATION = {
  file: { type: 'string', description: 'Absolute file path.' },
  symbol: { type: 'string', description: 'Identifier to locate as a whole word in file. Preferred over column.' },
  line: { type: 'integer', minimum: 1, description: '1-based line; narrows symbol, or is the position when symbol is absent.' },
  column: { type: 'integer', minimum: 1, description: '1-based column, only without symbol; default 1.' },
  snippet: { type: 'string', description: 'Text on the symbol\'s line, to pick one of several matches.' },
};
const MAX_RESULTS = { type: 'integer', minimum: 1, description: `Cap on listed results; default ${DEFAULT_MAX_RESULTS}.` };

const ARGS_DESCRIPTION = 'Positional command arguments. VS Code types are written as {"$uri": "/abs/path or scheme://..."}, '
  + '{"$symbol": {"file": "/abs/path", "name": "id", "line"?: n, "snippet"?: "text"}} (a Position at that identifier), '
  + '{"$position": [line, column]} and {"$range": [line, column, endLine, endColumn]}, all 1-based.';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const object = (properties, required) => ({ type: 'object', properties: { workspace: WORKSPACE, ...properties }, ...(required ? { required } : {}) });

const TOOLS = [
  {
    name: 'list_windows',
    description: 'List VS Code windows with a live bridge (pid, version, workspaceName, workspaceFile, folders).',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: 'get_diagnostics',
    description: 'Read diagnostics (Problems panel) of a VS Code window through the native API without focusing it. '
      + 'Returns counts by severity and, inline, one line per diagnostic (path:line:col SEVERITY [source code] message); '
      + '`out` writes the full JSON array (resource, startLineNumber, startColumn, severity, message, ...) instead. '
      + 'Use settle_ms after a reload, clean, or edit to wait until language servers stop publishing. '
      + 'Use since with an earlier `out` snapshot to get only diagnostics that appeared or disappeared since then.',
    inputSchema: object({
      out: { type: 'string', description: 'Absolute path for an atomic JSON snapshot of all matching diagnostics.' },
      since: { type: 'string', description: 'Earlier `out` snapshot; return only added and removed diagnostics.' },
      min_count: { type: 'integer', minimum: 0, description: 'Fail when fewer diagnostics are returned.' },
      min_severity: { type: 'integer', enum: [1, 2, 4, 8], description: 'Only diagnostics at or above this severity: 8 error, 4 warning, 2 information, 1 hint.' },
      resource: { type: 'string', description: 'Only diagnostics whose file path contains this substring.' },
      exclude_sources: { type: 'array', items: { type: 'string' }, description: 'Drop diagnostics whose source contains any of these; default ["cspell"].' },
      open: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to open (not show, not save) first so language servers analyze them; implies a settle wait.' },
      settle_ms: { type: 'integer', minimum: 0, description: 'Wait until diagnostics have not changed for this many ms. Result has settled: true, or false on timeout.' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'Upper bound for waiting; default 120000.' },
      max_results: MAX_RESULTS,
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'execute_command',
    description: 'Run any VS Code command in a window without focusing it and return its result. Locations, symbols, '
      + 'outlines and hovers come back as compact text (relative path:line:col); other results as JSON, truncated at max_chars. '
      + 'Useful commands: vscode.executeDefinitionProvider, vscode.executeReferenceProvider, vscode.executeImplementationProvider, '
      + 'vscode.executeTypeDefinitionProvider, vscode.executeHoverProvider, vscode.executeDocumentSymbolProvider, '
      + 'vscode.executeWorkspaceSymbolProvider, java.clean.workspace. Commands that open dialogs still need the user. '
      + 'For reload, rename, file moves and call hierarchy use the dedicated tools.',
    inputSchema: object({
      command: { type: 'string', description: 'VS Code command ID; find IDs with list_commands.' },
      args: { type: 'array', description: ARGS_DESCRIPTION },
      format: { type: 'string', enum: ['text', 'json'], description: 'text (default) compacts known result shapes; json returns the encoded value.' },
      max_results: MAX_RESULTS,
      max_chars: { type: 'integer', minimum: 100, description: 'Truncate the result beyond this many characters; default 20000.' },
    }, ['command']),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'reload_window',
    description: 'Reload a VS Code window and wait until its bridge answers again with a new pid; with settle_ms, also wait '
      + 'for diagnostics to settle and return their counts (full array to `out`); the settle wait starts after the first '
      + 'diagnostics change or 30s, since restarted language servers publish late. If the window hosts this Claude Code '
      + 'session, returns {accepted: true, hostsThisSession: true} immediately: the session restarts and continues '
      + '(claudeCode.continueAfterReload, on by default); then confirm with list_windows. Refuses when other Claude Code '
      + 'sessions run in the window, because reloading stops their background subagents; pass force: true only after the user agreed.',
    inputSchema: object({
      settle_ms: { type: 'integer', minimum: 0, description: 'After reload, wait until diagnostics have not changed for this many ms.' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'Upper bound for the whole reload; default 120000.' },
      out: { type: 'string', description: 'With settle_ms: absolute path for the diagnostics snapshot.' },
      force: { type: 'boolean', description: 'Reload even though other Claude Code sessions run in the window. Only after the user agreed.' },
    }),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'rename_symbol',
    description: 'Rename a symbol across the workspace through the language server (like F2), apply the edit, and save '
      + 'only the files it touched. Refuses when a touched file has unsaved changes. Returns changed files and edit counts.',
    inputSchema: object({ ...LOCATION, new_name: { type: 'string', description: 'New identifier.' } }, ['file', 'new_name']),
    annotations: WRITES,
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or folder through VS Code so language extensions update imports and references '
      + '(unlike mv), then save the files they updated.',
    inputSchema: object({
      from: { type: 'string', description: 'Absolute source path.' },
      to: { type: 'string', description: 'Absolute target path.' },
      overwrite: { type: 'boolean', description: 'Replace an existing target; default false.' },
    }, ['from', 'to']),
    annotations: WRITES,
  },
  {
    name: 'call_hierarchy',
    description: 'Show who calls a function (incoming) or what it calls (outgoing), as an indented tree with relative path:line:col.',
    inputSchema: object({
      ...LOCATION,
      direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Default incoming.' },
      depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Levels to expand; default 1.' },
      max_results: MAX_RESULTS,
    }, ['file']),
    annotations: READ_ONLY,
  },
  {
    name: 'list_commands',
    description: 'List VS Code command IDs available in a window (at most 500, sorted), optionally filtered by substring.',
    inputSchema: object({ filter: { type: 'string', description: 'Only command IDs containing this substring.' } }),
    annotations: READ_ONLY,
  },
  {
    name: 'list_tasks',
    description: 'List tasks VS Code can run in a window (tasks.json and auto-detected tasks such as npm or gradle).',
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: 'run_task',
    description: 'Run a VS Code task by name and wait for it to finish. Returns the exit code, or timedOut: true. '
      + 'Task output goes to its terminal; read it with get_terminal_output.',
    inputSchema: object({
      name: { type: 'string', description: 'Task name from list_tasks.' },
      source: { type: 'string', description: 'Task source from list_tasks, when several tasks share a name.' },
      folder: { type: 'string', description: 'Task folder from list_tasks, for multi-root workspaces.' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'Default 600000.' },
    }, ['name']),
    annotations: WRITES,
  },
  {
    name: 'get_terminal_output',
    description: 'Read output of commands run in VS Code integrated terminals, per command with exit code. '
      + 'Needs shell integration and only covers commands started after the bridge started; '
      + 'keeps the last 50 commands and 200,000 characters each.',
    inputSchema: object({
      terminal: { type: 'string', description: 'Terminal name; default is all terminals.' },
      limit: { type: 'integer', minimum: 1, description: 'Most recent commands to return; default 10.' },
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_debug_output',
    description: 'Read Debug Console output of a debug session (latest session by default). Only output produced after '
      + 'the bridge started is available; returns the last max_chars characters. VS Code has no API for Output panel '
      + 'channels: read those from log files under the VS Code logs directory (on macOS '
      + '~/Library/Application Support/Code/logs/<session>/window*/exthost/) or ask the user to copy them.',
    inputSchema: object({
      session: { type: 'string', description: 'Debug session id or name; default is the latest session.' },
      category: { type: 'string', description: 'Only this output category, e.g. stdout, stderr, console.' },
      filter: { type: 'string', description: 'Only lines containing this text.' },
      max_chars: { type: 'integer', minimum: 100, description: 'Default 20000.' },
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'debug_status',
    description: 'List debug sessions (with the stopped thread and reason, if paused), breakpoints, and launch configurations per folder.',
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: 'debug_start',
    description: 'Start debugging with a launch configuration (name from debug_status, or a configuration object). '
      + 'With wait_ms, wait until the session stops at a breakpoint or ends.',
    inputSchema: object({
      config: { description: 'Launch configuration name, or a full configuration object.' },
      folder: { type: 'string', description: 'Workspace folder that owns the configuration; default the first folder.' },
      no_debug: { type: 'boolean', description: 'Run without debugging.' },
      wait_ms: { type: 'integer', minimum: 0, description: 'Wait up to this long for the first stop or the end.' },
    }, ['config']),
    annotations: WRITES,
  },
  {
    name: 'debug_stop',
    description: 'Stop a debug session (latest running by default) and wait until it ends.',
    inputSchema: object({ session: { type: 'string', description: 'Session id or name.' } }),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'debug_breakpoints',
    description: 'Add, remove, clear, or list breakpoints; returns the resulting list. add takes file with symbol or line, '
      + 'plus optional condition, hit_condition, log_message. remove takes file and optional line; clear takes optional file.',
    inputSchema: object({
      action: { type: 'string', enum: ['add', 'remove', 'clear', 'list'], description: 'Default list.' },
      ...LOCATION,
      condition: { type: 'string', description: 'Break only when this expression is true.' },
      hit_condition: { type: 'string', description: 'Break when the hit count matches, e.g. ">= 3".' },
      log_message: { type: 'string', description: 'Logpoint message instead of breaking; {expr} interpolates.' },
    }),
    annotations: WRITES,
  },
  {
    name: 'debug_control',
    description: 'Continue, step (next, stepIn, stepOut), or pause a debug session, then wait for it to stop again and '
      + 'return the new top frame. Uses the thread that last stopped unless thread_id is given.',
    inputSchema: object({
      action: { type: 'string', enum: ['continue', 'next', 'stepIn', 'stepOut', 'pause'] },
      session: { type: 'string', description: 'Session id or name; default the latest running session.' },
      thread_id: { type: 'integer' },
      timeout_ms: { type: 'integer', minimum: 0, description: 'How long to wait for the next stop; default 30000. On timeout the result has running: true.' },
    }, ['action']),
    annotations: WRITES,
  },
  {
    name: 'debug_inspect',
    description: 'Inspect a paused debug session: call stack and variables of the top frame (or frame_id), or evaluate an '
      + 'expression there. Evaluating runs code in the debuggee.',
    inputSchema: object({
      session: { type: 'string', description: 'Session id or name; default the latest running session.' },
      thread_id: { type: 'integer' },
      frame_id: { type: 'integer', description: 'Frame id from the stack; default the top frame.' },
      expression: { type: 'string', description: 'Evaluate this instead of listing variables.' },
      levels: { type: 'integer', minimum: 1, description: 'Stack frames to return; default 20.' },
      max_variables: { type: 'integer', minimum: 1, description: 'Per scope; default 100.' },
    }),
    annotations: DESTRUCTIVE,
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
        if (res.statusCode === 404 && text.includes('"not found"')) {
          return reject(new ToolError(`This window runs bridge ${entry.version ?? '<3.0'} without ${route}; reload it to load the current extension.`));
        }
        if (res.statusCode >= 400) {
          let message = text;
          try { message = JSON.parse(text).error ?? text; } catch {}
          return reject(new ToolError(message));
        }
        try { resolve(JSON.parse(text)); } catch { reject(new ToolError(`Bridge returned invalid JSON: ${text}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(err instanceof ToolError ? err : new ToolError(`Bridge unreachable: ${err.message}`)));
    req.end(JSON.stringify(body));
  });
}

function writeJson(out, value) {
  if (!path.isAbsolute(out) || !fs.existsSync(path.dirname(out))) {
    throw new ToolError(`out must be an absolute path in an existing directory: ${out}`);
  }
  const tmp = `${out}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, out);
}

const identity = (item) => JSON.stringify(IDENTITY.map((key) => item[key]));

function relative(entry, file) {
  for (const folder of entry.folders ?? []) {
    const rel = path.relative(folder, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return (entry.folders.length > 1 ? `${path.basename(folder)}/` : '') + rel;
  }
  return file;
}

function lines(entry, items, maxResults) {
  const text = items.slice(0, maxResults).map((d) => `${relative(entry, d.resource)}:${d.startLineNumber}:${d.startColumn} `
    + `${SEVERITY_LABELS[d.severity] ?? d.severity}${d.source ? ` [${d.source}${d.code ? ` ${d.code}` : ''}]` : ''} ${d.message.replace(/\s*\n\s*/g, ' ')}`);
  if (items.length > maxResults) text.push(`... ${items.length - maxResults} more of ${items.length}; use out, resource, or min_severity`);
  return text;
}

async function getDiagnostics({
  workspace, out, since, min_count: minCount = 0, min_severity: minSeverity, resource, exclude_sources: excludeSources,
  open, settle_ms: settleMs, timeout_ms: timeoutMs, max_results: maxResults = DEFAULT_MAX_RESULTS,
}, firstChangeMs) {
  const entry = select(workspace);
  let baseline;
  if (since) {
    try {
      baseline = JSON.parse(fs.readFileSync(since, 'utf8'));
    } catch (err) {
      throw new ToolError(`Cannot read since snapshot ${since}: ${err.message}`);
    }
    if (!Array.isArray(baseline)) throw new ToolError(`since snapshot ${since} is not a diagnostics array`);
  }
  const { settled, items } = await call(entry, '/diagnostics', {
    minSeverity, resource, excludeSources, open, settleMs, timeoutMs, firstChangeMs,
  });
  if (items.length < minCount) throw new ToolError(`Only ${items.length} diagnostics, below min_count ${minCount}`);
  const counts = Object.fromEntries(Object.values(SEVERITY_NAMES).map((name) => [name, 0]));
  for (const item of items) {
    const name = SEVERITY_NAMES[item.severity];
    if (name) counts[name] += 1;
  }
  const result = { total: items.length, ...counts, ...(settled === null ? {} : { settled }) };
  if (out) {
    writeJson(out, items);
    result.saved = out;
  }
  if (baseline) {
    const before = new Set(baseline.map(identity));
    const now = new Set(items.map(identity));
    const added = items.filter((d) => !before.has(identity(d)));
    const removed = baseline.filter((d) => !now.has(identity(d)));
    return { ...result, added: added.length, removed: removed.length, new: lines(entry, added, maxResults), gone: lines(entry, removed, maxResults) };
  }
  return out ? result : { ...result, diagnostics: lines(entry, items, maxResults) };
}

function executeCommand({ command, workspace, args = [], format, max_results: maxResults, max_chars: maxChars } = {}) {
  if (typeof command !== 'string') throw new ToolError('command must be a string');
  if (command === 'workbench.action.reloadWindow') throw new ToolError('Use reload_window, which checks for other sessions in the window.');
  return call(select(workspace), '/command', { command, args, format, maxResults, maxChars });
}

// Stable across reloads, unlike pid; also accepted by select().
const windowKey = (e) => e.workspaceFile ?? e.folders?.[0] ?? e.workspaceName;
const FIRST_CHANGE_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// CommandLine is null for some access-denied system processes; CIM returns a bare object instead of
// a 1-element array when exactly one process is selected (won't happen given how many run, but cheap to guard).
function parseWinProcessList(json) {
  const rows = JSON.parse(json);
  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    table.set(row.ProcessId, { ppid: row.ParentProcessId, command: row.CommandLine ?? '' });
  }
  return table;
}

function processTable() {
  if (process.platform === 'win32') {
    try {
      const json = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return parseWinProcessList(json);
    } catch {
      return new Map();
    }
  }
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

// Matches the claude CLI's basename regardless of path separator, with or without a Windows executable extension.
const CLAUDE_PROC_RE = /(^|[\\/])claude(\.(exe|cmd|ps1))?(\s|$)/i;

// Claude Code sessions whose process descends from the extension host; background subagents run inside them.
function agentsInWindow(hostPid) {
  const table = processTable();
  const mine = new Set(ancestors(table, process.ppid));
  const hostsThisSession = mine.has(hostPid);
  const others = [];
  for (const [pid, { command }] of table) {
    if (mine.has(pid) || !CLAUDE_PROC_RE.test(command.split(' --')[0])) continue;
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
        { workspace: key, settle_ms: settleMs, timeout_ms: Math.max(deadline - Date.now(), 1), out, max_results: 20 },
        Math.min(FIRST_CHANGE_MS, deadline - Date.now()),
      );
      return { ...result, diagnostics };
    }
    candidate = entry;
  }
  throw new ToolError(`Window ${JSON.stringify(key)} did not come back within ${timeoutMs} ms`);
}

const location = ({ file, symbol, line, column, snippet }) => ({ file, symbol, line, column, snippet });
// Forwards a tool to an extension route, renaming snake_case arguments to the route's camelCase body.
const forward = (route, required = []) => (args = {}) => {
  for (const key of required) if (args[key] === undefined) throw new ToolError(`${key} is required`);
  const { workspace, ...rest } = args;
  const body = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key.replace(/_(\w)/g, (_, c) => c.toUpperCase()), value]));
  return call(select(workspace), route, body);
};

const HANDLERS = {
  list_windows: () => windows().map(summary),
  get_diagnostics: (args = {}) => getDiagnostics(args),
  execute_command: executeCommand,
  reload_window: reloadWindow,
  rename_symbol: ({ workspace, new_name: newName, ...where } = {}) => {
    if (!newName) throw new ToolError('new_name is required');
    return call(select(workspace), '/rename', { ...location(where), newName });
  },
  move_file: forward('/move-file', ['from', 'to']),
  call_hierarchy: ({ workspace, direction, depth, max_results: maxResults, ...where } = {}) => call(select(workspace), '/call-hierarchy', {
    ...location(where), direction, depth, maxResults,
  }),
  list_commands: forward('/commands'),
  list_tasks: forward('/tasks'),
  run_task: forward('/run-task', ['name']),
  get_terminal_output: forward('/terminal-output'),
  get_debug_output: forward('/debug-output'),
  debug_status: forward('/debug-status'),
  debug_start: forward('/debug-start', ['config']),
  debug_stop: forward('/debug-stop'),
  debug_breakpoints: forward('/breakpoints'),
  debug_control: forward('/debug-control', ['action']),
  debug_inspect: forward('/debug-inspect'),
};

// Returns the JSON-RPC result, or undefined for an unknown method.
async function handle({ method, params = {} }) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'vscode-agent-bridge', version: '4.1.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    try {
      const handler = HANDLERS[params.name];
      if (!handler) throw new ToolError(`Unknown tool: ${params.name}`);
      const value = await handler(params.arguments ?? {});
      return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
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

module.exports = {
  config, handle, HANDLERS, agentsInWindow, parseWinProcessList, CLAUDE_PROC_RE,
};
