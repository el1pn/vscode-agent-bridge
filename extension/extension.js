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
const MAX_MESSAGE_CHARS = 2000;
const MAX_RESULTS = 200;
const MAX_CHARS = 20_000;
const STEP_REQUESTS = ['continue', 'next', 'stepIn', 'stepOut', 'pause'];
// CSI and OSC escape sequences emitted by shells and shell integration.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

let server;
let registryFile;
const debugSessions = [];
const debugEvents = new vscode.EventEmitter();
const executions = [];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const rel = (uri) => vscode.workspace.asRelativePath(uri);
const at = (uri, range) => `${rel(uri)}:${range.start.line + 1}:${range.start.character + 1}`;
const kindName = (kind) => vscode.SymbolKind[kind] ?? String(kind);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDirty = (uri) => vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === uri.toString());

function toUri(value) {
  return /^[a-z][\w+.-]*:\/\//i.test(value) ? vscode.Uri.parse(value) : vscode.Uri.file(value);
}

// Finds `name` as a whole identifier, narrowed by a 1-based line and/or a snippet of that line. The position is
// the middle of the identifier, so it never lands on a modifier or decorator before it.
async function resolveSymbol({ file, name, line, snippet }) {
  if (!file || !name) throw new HttpError(400, 'A symbol needs file and name');
  const uri = toUri(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g');
  const hits = [];
  for (let i = line ? line - 1 : 0; i < (line || doc.lineCount) && i < doc.lineCount; i += 1) {
    const text = doc.lineAt(i).text;
    if (snippet && !text.includes(snippet)) continue;
    for (const match of text.matchAll(pattern)) hits.push({ line: i, character: match.index, text: text.trim() });
  }
  if (hits.length === 1) {
    return { uri, position: new vscode.Position(hits[0].line, hits[0].character + Math.floor(name.length / 2)) };
  }
  if (!hits.length) {
    throw new HttpError(404, `${name} not found in ${rel(uri)}${line ? ` on line ${line}` : ''}${snippet ? ` with snippet ${JSON.stringify(snippet)}` : ''}`);
  }
  const candidates = hits.slice(0, 20).map((h) => `${rel(uri)}:${h.line + 1}:${h.character + 1} ${h.text}`);
  throw new HttpError(409, `${hits.length} matches for ${name}; add line or snippet:\n${candidates.join('\n')}`);
}

// Accepts {file, symbol, line?, snippet?} or {file, line, column?}, 1-based.
async function locate({ file, symbol, line, column = 1, snippet }) {
  if (symbol) return resolveSymbol({ file, name: symbol, line, snippet });
  if (!file || !line) throw new HttpError(400, 'Give file with symbol, or file with line');
  return { uri: toUri(file), position: new vscode.Position(line - 1, column - 1) };
}

// JSON cannot carry VS Code types, so args use {$uri}, {$position: [line, column]},
// {$range: [line, column, endLine, endColumn]} (1-based) and {$symbol: {file, name, line?, snippet?}}.
async function decode(value) {
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (!value || typeof value !== 'object') return value;
  if ('$uri' in value) return toUri(value.$uri);
  if ('$symbol' in value) return (await resolveSymbol(value.$symbol)).position;
  if ('$position' in value) {
    const [line, column] = value.$position;
    return new vscode.Position(line - 1, column - 1);
  }
  if ('$range' in value) {
    const [line, column, endLine, endColumn] = value.$range;
    return new vscode.Range(line - 1, column - 1, endLine - 1, endColumn - 1);
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await decode(item)])));
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

const truncateLines = (lines, maxResults) => (lines.length > maxResults
  ? [...lines.slice(0, maxResults), `... ${lines.length - maxResults} more of ${lines.length}`]
  : lines);

// Text for result shapes agents read often (locations, symbols, outlines, hovers); undefined for anything else.
function compact(value, maxResults) {
  const items = Array.isArray(value) ? value : [value];
  const lines = [];
  const outline = (symbol, depth) => {
    lines.push(`${'  '.repeat(depth)}${kindName(symbol.kind)} ${symbol.name}${symbol.detail ? ` ${symbol.detail}` : ''} :${symbol.range.start.line + 1}`);
    for (const child of symbol.children ?? []) outline(child, depth + 1);
  };
  for (const item of items) {
    if (!item || typeof item !== 'object') return undefined;
    if (item.targetUri) lines.push(at(item.targetUri, item.targetSelectionRange ?? item.targetRange));
    else if (Array.isArray(item.children) && item.range) outline(item, 0);
    else if (item.location && typeof item.name === 'string') {
      lines.push(`${kindName(item.kind)} ${item.name}${item.containerName ? ` in ${item.containerName}` : ''} ${at(item.location.uri, item.location.range)}`);
    } else if (item.uri instanceof vscode.Uri && item.range) lines.push(at(item.uri, item.range));
    else if (Array.isArray(item.contents)) lines.push(item.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n'));
    else return undefined;
  }
  return lines.length ? truncateLines(lines, maxResults).join('\n') : '(no results)';
}

function limit(value, maxChars) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return value ?? null;
  return `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} of ${text.length} characters; narrow the request or raise max_chars`;
}

// Resolves true once `event` stays quiet for quietMs, false if timeoutMs passes first.
// firstChangeMs delays the first quiet window, for servers that are still starting and have not published yet.
function quiet(event, quietMs, timeoutMs, firstChangeMs = 0) {
  return new Promise((resolve) => {
    let timer;
    const done = (settled) => {
      clearTimeout(timer);
      clearTimeout(deadline);
      subscription.dispose();
      resolve(settled);
    };
    const deadline = setTimeout(done, timeoutMs, false);
    const subscription = event(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs, true);
    });
    timer = setTimeout(done, Math.max(quietMs, firstChangeMs), true);
  });
}

async function diagnostics({
  minSeverity = 1, resource, settleMs = 0, timeoutMs = 120_000, firstChangeMs = 0, excludeSources = ['cspell'], open = [],
}) {
  if (open.length) {
    // Opening (never saving or showing) makes language servers analyze files nobody has open yet.
    await Promise.all(open.map((file) => vscode.workspace.openTextDocument(toUri(file))));
    settleMs ||= 2000;
    firstChangeMs = Math.max(firstChangeMs, 10_000);
  }
  const settled = settleMs > 0 ? await quiet(vscode.languages.onDidChangeDiagnostics, settleMs, timeoutMs, firstChangeMs) : null;
  const excluded = excludeSources.map((source) => source.toLowerCase());
  const items = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    const file = uri.scheme === 'file' ? uri.fsPath : uri.toString();
    if (resource && !file.includes(resource)) continue;
    for (const d of list) {
      const severity = SEVERITY[d.severity];
      if (severity < minSeverity) continue;
      if (d.source && excluded.some((source) => d.source.toLowerCase().includes(source))) continue;
      items.push({
        resource: file,
        owner: d.source ?? '',
        code: typeof d.code === 'object' ? String(d.code.value) : d.code,
        severity,
        message: d.message.length > MAX_MESSAGE_CHARS ? `${d.message.slice(0, MAX_MESSAGE_CHARS)}...` : d.message,
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

async function command({ command: id, args = [], format = 'text', maxResults = MAX_RESULTS, maxChars = MAX_CHARS }) {
  if (typeof id !== 'string' || !Array.isArray(args)) throw new HttpError(400, 'command must be a string and args an array');
  // Reload tears down this host, so reply before running it.
  if (id === 'workbench.action.reloadWindow') {
    setTimeout(() => vscode.commands.executeCommand(id), 100);
    return { accepted: true };
  }
  let raw;
  try {
    raw = await vscode.commands.executeCommand(id, ...(await decode(args)));
  } catch (err) {
    if (/^command '.*' not found$/.test(err?.message)) throw new HttpError(404, `${err.message}; find ids with list_commands`);
    throw err;
  }
  return limit((format === 'json' ? undefined : compact(raw, maxResults)) ?? encode(raw), maxChars);
}

async function commands({ filter = '' }) {
  const all = (await vscode.commands.getCommands(true)).filter((id) => id.includes(filter)).sort();
  return { total: all.length, commands: all.slice(0, 500) };
}

// workspace.save(uri) only saves documents shown in an editor, so save through the document itself.
// Returns the relative paths that could not be saved.
async function saveAll(uris) {
  const failed = [];
  for (const uri of uris) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty && !(await doc.save())) failed.push(rel(uri));
  }
  return failed;
}

async function rename({ newName, ...where }) {
  if (!newName) throw new HttpError(400, 'newName is required');
  const { uri, position } = await locate(where);
  let edit;
  try {
    edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, position, newName);
  } catch (err) {
    throw new HttpError(409, `Rename rejected: ${err?.message ?? err}`);
  }
  if (!edit || edit.size === 0) throw new HttpError(409, `Nothing renameable at ${at(uri, new vscode.Range(position, position))}`);
  const entries = edit.entries();
  const dirty = entries.filter(([target]) => isDirty(target)).map(([target]) => rel(target));
  // Applying over unsaved buffers would mix the user's pending edits with ours and then save both.
  if (dirty.length) throw new HttpError(409, `Unsaved changes in ${dirty.join(', ')}; save or revert them first`);
  if (!(await vscode.workspace.applyEdit(edit, { isRefactoring: true }))) throw new HttpError(409, 'VS Code refused to apply the rename');
  const unsaved = await saveAll(entries.map(([target]) => target));
  const files = entries.map(([target, edits]) => ({ file: rel(target), edits: edits.length }));
  return { files, totalEdits: files.reduce((sum, f) => sum + f.edits, 0), ...(unsaved.length ? { unsaved } : {}) };
}

async function moveFile({ from, to, overwrite = false, quietMs = 2000 }) {
  if (!from || !to) throw new HttpError(400, 'from and to are required');
  const source = toUri(from);
  const target = toUri(to);
  const before = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
  if ([...before].some((uri) => uri === source.toString() || uri.startsWith(`${source.toString()}/`))) {
    throw new HttpError(409, `Unsaved changes under ${rel(source)}; save or revert them first`);
  }
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(source, target, { overwrite });
  if (!(await vscode.workspace.applyEdit(edit, { isRefactoring: true }))) {
    throw new HttpError(409, `VS Code refused to move ${rel(source)} (target exists? pass overwrite)`);
  }
  // Import updaters run as rename participants or shortly after the move, so wait for edits to stop before saving.
  await quiet(vscode.workspace.onDidChangeTextDocument, quietMs, 30_000);
  const updated = vscode.workspace.textDocuments.filter((d) => d.isDirty && !before.has(d.uri.toString())).map((d) => d.uri);
  const unsaved = await saveAll(updated);
  const language = /\.[cm]?tsx?$/.test(from) ? 'typescript' : /\.[cm]?jsx?$/.test(from) ? 'javascript' : null;
  const prompts = language && vscode.workspace.getConfiguration(language).get('updateImportsOnFileMove.enabled') === 'prompt';
  return {
    moved: rel(target),
    updatedFiles: updated.map(rel),
    ...(unsaved.length ? { unsaved } : {}),
    ...(prompts ? { note: `${language}.updateImportsOnFileMove.enabled is "prompt": VS Code may be asking the user whether to update imports` } : {}),
  };
}

const describeItem = (item) => `${kindName(item.kind)} ${item.name}${item.detail ? ` ${item.detail}` : ''} ${at(item.uri, item.selectionRange)}`;

// Items from prepareCallHierarchy must be passed back as live objects, so the whole walk runs in one request.
async function callHierarchy({ direction = 'incoming', depth = 1, maxResults = MAX_RESULTS, ...where }) {
  if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new HttpError(400, 'direction must be incoming, outgoing or both');
  const { uri, position } = await locate(where);
  const roots = (await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position)) ?? [];
  if (!roots.length) throw new HttpError(404, `No call hierarchy at ${at(uri, new vscode.Range(position, position))}`);
  const lines = [];
  let count = 0;
  const walk = async (item, level, dir) => {
    if (level > Math.min(depth, 5)) return;
    const calls = (await vscode.commands.executeCommand(dir === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls', item)) ?? [];
    for (const call of calls) {
      if (count >= maxResults) return;
      count += 1;
      const other = dir === 'incoming' ? call.from : call.to;
      const lineNumbers = [...new Set(call.fromRanges.map((r) => r.start.line + 1))].join(',');
      lines.push(`${'  '.repeat(level)}${dir === 'incoming' ? '<-' : '->'} ${describeItem(other)} (call at line ${lineNumbers})`);
      await walk(other, level + 1, dir);
    }
  };
  for (const root of roots) {
    lines.push(describeItem(root));
    for (const dir of direction === 'both' ? ['incoming', 'outgoing'] : [direction]) await walk(root, 1, dir);
  }
  if (count >= maxResults) lines.push(`... stopped at ${maxResults} calls`);
  return lines.join('\n');
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
  const record = {
    id: session.id, name: session.name, type: session.type, session, parent: session.parentSession?.id ?? null, started: Date.now(), ended: null,
    stopped: null, stops: 0, chars: 0, output: [],
  };
  debugSessions.push(record);
  if (debugSessions.length > MAX_DEBUG_SESSIONS) debugSessions.shift();
  const end = () => {
    record.ended ??= Date.now();
    debugEvents.fire(record);
  };
  return {
    onDidSendMessage({ type, event, body }) {
      if (type !== 'event') return;
      if (event === 'stopped') {
        record.stopped = { threadId: body?.threadId ?? null, reason: body?.reason ?? null, description: body?.description ?? null };
        record.stops += 1;
        debugEvents.fire(record);
      } else if (event === 'continued') {
        record.stopped = null;
      } else if (event === 'terminated' || event === 'exited') {
        end();
      } else if (event === 'output' && body?.output) {
        record.output.push({ category: body.category ?? 'console', text: body.output });
        record.chars += body.output.length;
        while (record.chars > MAX_DEBUG_CHARS && record.output.length > 1) {
          record.chars -= record.output.shift().text.length;
          record.truncated = true;
        }
      }
    },
    onWillStopSession: end,
    onExit: end,
  };
}

const describeRecord = (r) => ({ id: r.id, name: r.name, type: r.type, parent: r.parent, ended: r.ended, stopped: r.stopped });

// Adapters such as js-debug run the program in child sessions, so a launch's stops happen in its descendants.
function inFamily(record, root) {
  for (let r = record; r; r = debugSessions.find((s) => s.id === r.parent)) if (r === root) return true;
  return false;
}

// Without a name, prefer the latest paused session, since that is where stack and stepping apply.
function findRecord(session, { live = false } = {}) {
  const matches = debugSessions.filter((r) => (!session || r.id === session || r.name === session) && (!live || !r.ended));
  const record = (!session && matches.filter((r) => r.stopped).at(-1)) || matches.at(-1);
  if (!record) throw new HttpError(404, `No ${live ? 'running ' : ''}debug session${session ? ` ${JSON.stringify(session)}` : ''}`);
  return record;
}

// Resolves the first record matching predicate, or null on timeout.
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { subscription.dispose(); resolve(null); }, timeoutMs);
    const subscription = debugEvents.event((record) => {
      if (!predicate(record)) return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(record);
    });
  });
}

function debugOutput({ session, category, filter, maxChars = MAX_CHARS }) {
  const record = session ? debugSessions.findLast((r) => r.id === session || r.name === session) : debugSessions.at(-1);
  let output = record ? record.output.filter((o) => !category || o.category === category).map((o) => o.text).join('') : '';
  if (filter) output = output.split('\n').filter((line) => line.includes(filter)).join('\n');
  const hint = record && !output && record.session.configuration.console === 'integratedTerminal'
    ? 'This session writes to the integrated terminal; read it with get_terminal_output or launch with "console": "internalConsole".'
    : undefined;
  return {
    sessions: debugSessions.map(describeRecord),
    session: record ? { ...describeRecord(record), truncated: Boolean(record.truncated) } : null,
    output: output.length > maxChars ? `... ${output.length - maxChars} earlier characters omitted\n${output.slice(-maxChars)}` : output,
    ...(hint ? { hint } : {}),
  };
}

function describeBreakpoint(b) {
  const where = b.location ? at(b.location.uri, b.location.range) : `function ${b.functionName}`;
  const extra = [b.condition && `if ${b.condition}`, b.hitCondition && `hit ${b.hitCondition}`,
    b.logMessage && `log ${JSON.stringify(b.logMessage)}`, !b.enabled && 'disabled'].filter(Boolean);
  return [where, ...extra].join(' ');
}

function launchConfigurations(scope) {
  const launch = vscode.workspace.getConfiguration('launch', scope);
  return { configurations: (launch.get('configurations') ?? []).map((c) => c.name), compounds: (launch.get('compounds') ?? []).map((c) => c.name) };
}

function debugStatus() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return {
    sessions: debugSessions.map(describeRecord),
    breakpoints: vscode.debug.breakpoints.map(describeBreakpoint),
    launch: folders.length ? Object.fromEntries(folders.map((f) => [f.uri.fsPath, launchConfigurations(f.uri)])) : launchConfigurations(),
  };
}

async function debugStart({ folder, config, noDebug = false, waitMs = 0 }) {
  if (!config) throw new HttpError(400, 'config is a launch configuration name or object');
  const scope = folder ? vscode.workspace.getWorkspaceFolder(toUri(folder)) : vscode.workspace.workspaceFolders?.[0];
  if (folder && !scope) throw new HttpError(400, `${folder} is not in a workspace folder`);
  let subscription;
  const started = new Promise((resolve) => { subscription = vscode.debug.onDidStartDebugSession(resolve); });
  try {
    if (!(await vscode.debug.startDebugging(scope, config, { noDebug }))) {
      throw new HttpError(409, 'Debugging did not start: unknown configuration, failed preLaunchTask, or adapter error');
    }
    const session = await Promise.race([started, sleep(5000)]);
    const record = session && debugSessions.find((r) => r.id === session.id);
    if (!record) return { started: true, session: session ? { id: session.id, name: session.name } : null };
    const done = (r) => inFamily(r, record) && (r.stopped || (r === record && r.ended));
    const already = debugSessions.find((r) => done(r));
    const hit = already ?? (waitMs ? await waitFor(done, waitMs) : null);
    return hit ? describeRecord(hit) : { ...describeRecord(record), running: true };
  } finally {
    subscription.dispose();
  }
}

async function debugStop({ session }) {
  const record = findRecord(session, { live: true });
  const ended = waitFor((r) => r === record && r.ended, 10_000);
  await vscode.debug.stopDebugging(record.session);
  await ended;
  return describeRecord(record);
}

async function breakpoints({ action = 'list', file, line, symbol, snippet, condition, hitCondition, logMessage }) {
  if (action === 'add') {
    const { uri, position } = await locate({ file, line, symbol, snippet });
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, position), true, condition, hitCondition, logMessage)]);
  } else if (action === 'remove' || action === 'clear') {
    if (action === 'remove' && !file) throw new HttpError(400, 'remove needs file (and optionally line)');
    const target = file && toUri(file).toString();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter((b) => (!target || b.location?.uri.toString() === target)
      && (action === 'clear' || !line || b.location?.range.start.line === line - 1)));
  } else if (action !== 'list') {
    throw new HttpError(400, 'action must be add, remove, clear or list');
  }
  return vscode.debug.breakpoints.map(describeBreakpoint);
}

const describeFrame = (f) => `#${f.id} ${f.name} ${f.source?.path ? rel(vscode.Uri.file(f.source.path)) : f.source?.name ?? '?'}:${f.line}`;

// Prefer the thread that actually stopped; the first thread is only a last resort.
async function threadOf(record, threadId) {
  // Thread ids may be 0 (js-debug), so test for null, not truthiness.
  if (threadId != null) return threadId;
  if (record.stopped?.threadId != null) return record.stopped.threadId;
  const item = vscode.debug.activeStackItem;
  if (item?.session?.id === record.id && item.threadId != null) return item.threadId;
  const { threads = [] } = await record.session.customRequest('threads');
  if (!threads.length) throw new HttpError(409, 'Debug session has no threads');
  return threads[0].id;
}

async function debugControl({ session, action, threadId, timeoutMs = 30_000 }) {
  if (!STEP_REQUESTS.includes(action)) throw new HttpError(400, `action must be one of ${STEP_REQUESTS.join(', ')}`);
  const record = findRecord(session, { live: true });
  if (action !== 'pause' && !record.stopped) throw new HttpError(409, 'Session is running; pause it or wait for a breakpoint');
  const thread = await threadOf(record, threadId);
  const { stops, stopped } = record;
  const next = waitFor((r) => r === record && (r.stops > stops || r.ended), timeoutMs);
  // Adapters need not send "continued" after a step, so mark running ourselves.
  if (action !== 'pause') record.stopped = null;
  try {
    await record.session.customRequest(action, { threadId: thread });
  } catch (err) {
    record.stopped = stopped;
    throw new HttpError(409, `${action} failed: ${err?.message ?? err}`);
  }
  if (!(await next)) return { ...describeRecord(record), running: true };
  if (record.ended) return describeRecord(record);
  const { stackFrames = [] } = await record.session.customRequest('stackTrace', { threadId: record.stopped.threadId ?? thread, startFrame: 0, levels: 1 });
  return { ...describeRecord(record), frame: stackFrames[0] ? describeFrame(stackFrames[0]) : null };
}

async function debugInspect({ session, threadId, frameId, expression, levels = 20, maxVariables = 100 }) {
  const record = findRecord(session, { live: true });
  if (!record.stopped && !expression) throw new HttpError(409, 'Session is running; stack and variables need a stopped thread');
  const request = (name, args) => record.session.customRequest(name, args);
  const thread = record.stopped ? await threadOf(record, threadId) : null;
  const { stackFrames = [] } = thread != null ? await request('stackTrace', { threadId: thread, startFrame: 0, levels }) : {};
  const frame = frameId ?? stackFrames[0]?.id;
  if (expression) {
    const result = await request('evaluate', { expression, frameId: frame, context: 'repl' });
    return { expression, result: result.result, type: result.type ?? null };
  }
  const { scopes = [] } = await request('scopes', { frameId: frame });
  const variables = {};
  for (const scope of scopes) {
    if (scope.expensive) {
      variables[scope.name] = ['(expensive scope; evaluate an expression instead)'];
      continue;
    }
    const { variables: list = [] } = await request('variables', { variablesReference: scope.variablesReference });
    variables[scope.name] = truncateLines(list.map((v) => `${v.name}${v.type ? `: ${v.type}` : ''} = ${v.value}`), maxVariables);
  }
  return { thread, stopped: record.stopped, frame, frames: stackFrames.map(describeFrame), variables };
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

function terminalOutput({ terminal, limit: count = 10 }) {
  return {
    terminals: vscode.window.terminals.map((t) => t.name),
    executions: executions
      .filter((r) => !terminal || r.terminal === terminal)
      .slice(-count)
      .map((r) => ({ ...r, output: r.output.replace(ANSI, '') })),
  };
}

const ROUTES = {
  '/diagnostics': diagnostics,
  '/command': command,
  '/commands': commands,
  '/rename': rename,
  '/move-file': moveFile,
  '/call-hierarchy': callHierarchy,
  '/tasks': tasks,
  '/run-task': runTask,
  '/terminal-output': terminalOutput,
  '/debug-output': debugOutput,
  '/debug-status': debugStatus,
  '/debug-start': debugStart,
  '/debug-stop': debugStop,
  '/breakpoints': breakpoints,
  '/debug-control': debugControl,
  '/debug-inspect': debugInspect,
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
    debugEvents,
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
