// Self-check that needs no running VS Code: node --test mcp/server.test.js
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { config, handle, HANDLERS } = require('./server.js');

const TOKEN = 't';
const DIAGNOSTICS = [{ resource: '/a.ts', startLineNumber: 1, startColumn: 1, severity: 8, message: 'x' }];

async function call(name, args = {}) {
  const result = await handle({ method: 'tools/call', params: { name, arguments: args } });
  return { isError: Boolean(result.isError), value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

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
    assert.ok((await call('get_diagnostics', { min_count: 2 })).isError);
    assert.ok((await call('get_diagnostics', { workspace: 'other' })).isError);

    const expected = {
      execute_command: [{ command: 'a.b', args: [{ $uri: '/a.ts' }] }, '/command', { command: 'a.b', args: [{ $uri: '/a.ts' }] }],
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
    assert.ok((await call('nope')).isError);

    const { tools } = await handle({ method: 'tools/list' });
    assert.deepStrictEqual(tools.map((t) => t.name), Object.keys(HANDLERS));
    assert.strictEqual(await handle({ method: 'bogus' }), undefined);
  } finally {
    bridge.close();
    fs.rmSync(config.registry, { recursive: true, force: true });
  }
});
