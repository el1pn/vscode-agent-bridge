// Localhost bridge so automation can read diagnostics and run commands without raising the window.
const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_DIR = path.join(os.homedir(), '.vscode-agent-bridge');
// Same numeric severities the Problems panel uses when copied as JSON.
const SEVERITY = { 0: 8, 1: 4, 2: 2, 3: 1 };

let server;
let registryFile;

function diagnostics() {
  const out = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    const resource = uri.scheme === 'file' ? uri.fsPath : uri.toString();
    for (const d of list) {
      out.push({
        resource,
        owner: d.source ?? '',
        code: typeof d.code === 'object' ? String(d.code.value) : d.code,
        severity: SEVERITY[d.severity],
        message: d.message,
        source: d.source,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
      });
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function activate() {
  const token = crypto.randomBytes(24).toString('hex');
  server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/diagnostics') return send(200, diagnostics());
      if (req.method === 'POST' && req.url === '/command') {
        const { command, args = [] } = await readBody(req);
        if (typeof command !== 'string' || !Array.isArray(args)) return send(400, { error: 'command must be a string and args an array' });
        // Reload tears down this host, so reply before running it.
        if (command === 'workbench.action.reloadWindow') {
          send(202, { accepted: true });
          return void setTimeout(() => vscode.commands.executeCommand(command), 100);
        }
        const result = await vscode.commands.executeCommand(command, ...args);
        let serializable;
        try { serializable = JSON.parse(JSON.stringify(result ?? null)); } catch { serializable = String(result); }
        return send(200, { result: serializable });
      }
      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: String(err?.message ?? err) });
    }
  });

  server.listen(0, '127.0.0.1', () => {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    registryFile = path.join(REGISTRY_DIR, `${process.pid}.json`);
    const entry = {
      pid: process.pid,
      port: server.address().port,
      token,
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
