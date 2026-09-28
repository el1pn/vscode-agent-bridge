// Self-check that needs no running VS Code: node --test mcp/server.test.js
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { config, handle, HANDLERS } = require('./server.js');

const TOKEN = 't';

async function call(name, args = {}) {
  const result = await handle({ method: 'tools/call', params: { name, arguments: args } });
  return { isError: Boolean(result.isError), value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

test('routes tools to the registered bridge', async () => {
  config.registry = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  assert.ok((await call('get_diagnostics')).isError, 'no bridge registered');

  const bridge = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET'
        ? [{ resource: '/a.ts', startLineNumber: 1, startColumn: 1, severity: 8, message: 'x' }]
        : { result: JSON.parse(body) }));
    });
  });
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const entry = { pid: process.pid, port: bridge.address().port, token: TOKEN, workspaceName: 'ws', folders: ['/ws'] };
  fs.writeFileSync(path.join(config.registry, '1.json'), JSON.stringify(entry));
  fs.writeFileSync(path.join(config.registry, '2.json'), JSON.stringify({ ...entry, pid: 2 ** 22 + 1 })); // dead pid
  fs.writeFileSync(path.join(config.registry, '3.json'), '[]'); // malformed entry

  try {
    assert.deepStrictEqual((await call('list_windows')).value.map((w) => w.workspaceName), ['ws']);
    assert.ok(!fs.existsSync(path.join(config.registry, '2.json')), 'dead entry pruned');

    const out = path.join(config.registry, 'diag.json');
    const { value } = await call('get_diagnostics', { workspace: '/ws', out });
    assert.strictEqual(value.total, 1);
    assert.strictEqual(value.errors, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).length, 1);
    assert.ok((await call('get_diagnostics', { min_count: 2 })).isError);
    assert.ok((await call('get_diagnostics', { workspace: 'other' })).isError);

    const sent = (await call('execute_command', { command: 'a.b', args: [1] })).value;
    assert.deepStrictEqual(sent.result, { command: 'a.b', args: [1] });
    assert.ok((await call('nope')).isError);

    const { tools } = await handle({ method: 'tools/list' });
    assert.deepStrictEqual(tools.map((t) => t.name), Object.keys(HANDLERS));
    assert.strictEqual(await handle({ method: 'bogus' }), undefined);
  } finally {
    bridge.close();
    fs.rmSync(config.registry, { recursive: true, force: true });
  }
});
