// Self-check that needs no running VS Code: node --test mcp/server.test.js
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  config, handle, HANDLERS, agentsInWindow, parseWinProcessList, CLAUDE_PROC_RE,
} = require('./server.js');

const TOKEN = 't';
const DIAGNOSTICS = [{ resource: '/a.ts', startLineNumber: 1, startColumn: 1, severity: 8, message: 'x' }];

async function call(name, args = {}) {
  const result = await handle({ method: 'tools/call', params: { name, arguments: args } });
  return { isError: Boolean(result.isError), value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

test('parseWinProcessList maps CIM output to the pid table', () => {
  const normal = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, CommandLine: 'C:\\Windows\\System32\\wininit.exe' },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: null }, // access-denied system process
  ]);
  assert.deepStrictEqual(parseWinProcessList(normal), new Map([
    [1, { ppid: 0, command: 'C:\\Windows\\System32\\wininit.exe' }],
    [2, { ppid: 1, command: '' }],
  ]));

  // CIM emits a bare object instead of a 1-element array when only one process is selected.
  const single = JSON.stringify({ ProcessId: 9, ParentProcessId: 1, CommandLine: 'x' });
  assert.deepStrictEqual(parseWinProcessList(single), new Map([[9, { ppid: 1, command: 'x' }]]));
});

test('CLAUDE_PROC_RE matches the claude CLI on both POSIX and Windows', () => {
  assert.ok(CLAUDE_PROC_RE.test('/usr/local/bin/claude'));
  assert.ok(CLAUDE_PROC_RE.test('/usr/local/bin/claude --foo'));
  assert.ok(CLAUDE_PROC_RE.test('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd'));
  assert.ok(CLAUDE_PROC_RE.test('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.exe --output-format stream-json'));
  assert.ok(!CLAUDE_PROC_RE.test('C:\\tools\\claude-something-else.exe'));
  assert.ok(!CLAUDE_PROC_RE.test('/usr/local/bin/not-claude'));
});

test('routes tools to the registered bridge', async () => {
  config.registry = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  assert.ok((await call('get_diagnostics')).isError, 'no bridge registered');

  // Fake extension: echoes the route and body, except /diagnostics which returns fixed items.
  const bridge = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/diagnostics'
        ? { settled: JSON.parse(body).settleMs ? true : null, items: DIAGNOSTICS }
        : { method: req.method, route: req.url, body: JSON.parse(body) }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const entry = { pid: process.pid, port: bridge.address().port, token: TOKEN, version: '3.0.0', workspaceName: 'ws', folders: ['/ws'] };
  fs.writeFileSync(path.join(config.registry, '1.json'), JSON.stringify(entry));
  fs.writeFileSync(path.join(config.registry, '2.json'), JSON.stringify({ ...entry, pid: 2 ** 22 + 1 })); // dead pid
  fs.writeFileSync(path.join(config.registry, '3.json'), '[]'); // malformed entry

  try {
    const windows = (await call('list_windows')).value;
    assert.deepStrictEqual(windows.map((w) => [w.workspaceName, w.version]), [['ws', '3.0.0']]);
    assert.ok(!fs.existsSync(path.join(config.registry, '2.json')), 'dead entry pruned');

    const out = path.join(config.registry, 'diag.json');
    const saved = (await call('get_diagnostics', { workspace: '/ws', out })).value;
    assert.strictEqual(saved.total, 1);
    assert.strictEqual(saved.errors, 1);
    assert.ok(!('settled' in saved));
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).length, 1);
    assert.strictEqual((await call('get_diagnostics', { settle_ms: 100 })).value.settled, true);
    // Inline results are one line per diagnostic, relative to the window folder.
    assert.deepStrictEqual((await call('get_diagnostics')).value.diagnostics, ['/a.ts:1:1 ERROR x']);
    // since: diff against an earlier snapshot by the five-field identity.
    const older = path.join(config.registry, 'older.json');
    fs.writeFileSync(older, JSON.stringify([{ resource: '/b.ts', startLineNumber: 2, startColumn: 1, severity: 4, message: 'gone' }]));
    const diff = (await call('get_diagnostics', { since: older })).value;
    assert.deepStrictEqual([diff.added, diff.removed, diff.new, diff.gone], [1, 1, ['/a.ts:1:1 ERROR x'], ['/b.ts:2:1 WARN gone']]);
    assert.ok((await call('get_diagnostics', { since: '/nonexistent.json' })).isError);
    assert.ok((await call('get_diagnostics', { min_count: 2 })).isError);
    assert.ok((await call('get_diagnostics', { workspace: 'other' })).isError);

    const expected = {
      execute_command: [{ command: 'a.b', args: [{ $uri: '/a.ts' }], max_chars: 500 }, '/command', { command: 'a.b', args: [{ $uri: '/a.ts' }], maxChars: 500 }],
      rename_symbol: [{ file: '/a.ts', symbol: 'foo', new_name: 'bar' }, '/rename', { file: '/a.ts', symbol: 'foo', newName: 'bar' }],
      move_file: [{ from: '/a.ts', to: '/b.ts' }, '/move-file', { from: '/a.ts', to: '/b.ts' }],
      call_hierarchy: [{ file: '/a.ts', line: 3, direction: 'both' }, '/call-hierarchy', { file: '/a.ts', line: 3, direction: 'both' }],
      debug_status: [{}, '/debug-status', {}],
      debug_start: [{ config: 'App', wait_ms: 10 }, '/debug-start', { config: 'App', waitMs: 10 }],
      debug_stop: [{ session: 's1' }, '/debug-stop', { session: 's1' }],
      debug_breakpoints: [{ action: 'add', file: '/a.ts', line: 4, hit_condition: '>2' }, '/breakpoints', { action: 'add', file: '/a.ts', line: 4, hitCondition: '>2' }],
      debug_control: [{ action: 'next', thread_id: 7 }, '/debug-control', { action: 'next', threadId: 7 }],
      debug_inspect: [{ expression: 'x', frame_id: 2 }, '/debug-inspect', { expression: 'x', frameId: 2 }],
      list_commands: [{ filter: 'java' }, '/commands', { filter: 'java' }],
      list_tasks: [{}, '/tasks', {}],
      run_task: [{ name: 'build', folder: '/ws', timeout_ms: 5 }, '/run-task', { name: 'build', folder: '/ws', timeoutMs: 5 }],
      get_debug_output: [{ category: 'stderr' }, '/debug-output', { category: 'stderr' }],
      get_terminal_output: [{ limit: 3 }, '/terminal-output', { limit: 3 }],
    };
    for (const [tool, [args, route, body]] of Object.entries(expected)) {
      assert.deepStrictEqual((await call(tool, args)).value, { method: 'POST', route, body }, tool);
    }
    assert.ok((await call('execute_command', {})).isError);
    assert.ok((await call('run_task', {})).isError);
    assert.ok((await call('rename_symbol', { file: '/a.ts' })).isError, 'new_name required');
    assert.ok((await call('move_file', { from: '/a.ts' })).isError, 'to required');
    assert.ok((await call('debug_control', {})).isError, 'action required');
    const { tools: listed } = await handle({ method: 'tools/list' });
    assert.ok(listed.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'), 'every tool is annotated');
    assert.ok((await call('nope')).isError);

    // Reload: the "new host" is a registry entry with another live pid (this test's parent) on the same port.
    const reloaded = { ...entry, pid: process.ppid };
    setTimeout(() => {
      fs.rmSync(path.join(config.registry, '1.json'));
      fs.writeFileSync(path.join(config.registry, '9.json'), JSON.stringify(reloaded));
    }, 200);
    const reload = (await call('reload_window', { workspace: '/ws', settle_ms: 10, timeout_ms: 10_000 })).value;
    assert.deepStrictEqual([reload.oldPid, reload.newPid, reload.diagnostics.total], [process.pid, process.ppid, 1]);
    // ppid hosts this process, so reloading it must not wait for a restart this process would not survive.
    assert.deepStrictEqual((await call('reload_window', { workspace: '/ws' })).value, { accepted: true, oldPid: process.ppid, hostsThisSession: true });
    fs.writeFileSync(path.join(config.registry, '9.json'), JSON.stringify(entry));
    assert.ok((await call('reload_window', { workspace: '/ws', timeout_ms: 1500 })).isError, 'no new pid');
    assert.ok((await call('execute_command', { command: 'workbench.action.reloadWindow' })).isError, 'reload goes through reload_window');

    // A child `claude` process of the window's host counts as another session and blocks the reload.
    const { spawn } = require('child_process');
    const bin = path.join(config.registry, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const other = spawn(bin, ['--output-format', 'stream-json']);
    try {
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      assert.deepStrictEqual(agentsInWindow(process.pid).others, [other.pid]);
      fs.writeFileSync(path.join(config.registry, '9.json'), JSON.stringify(entry));
      const refused = await call('reload_window', { workspace: '/ws' });
      assert.ok(refused.isError && refused.value.includes(`pid ${other.pid}`), refused.value);
    } finally {
      other.kill();
    }

    const { tools } = await handle({ method: 'tools/list' });
    assert.deepStrictEqual(tools.map((t) => t.name), Object.keys(HANDLERS));
    assert.strictEqual(await handle({ method: 'bogus' }), undefined);
  } finally {
    bridge.close();
    fs.rmSync(config.registry, { recursive: true, force: true });
  }
});
