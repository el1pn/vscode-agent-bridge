#!/usr/bin/env python3
"""Self-check for server.py that needs no running VS Code: python3 mcp/test_server.py"""
import json
import pathlib
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import server

TOKEN = "t"


class FakeBridge(BaseHTTPRequestHandler):
    def reply(self, value):
        if self.headers["Authorization"] != f"Bearer {TOKEN}":
            self.send_response(401)
            self.end_headers()
            return
        body = json.dumps(value).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply([{"resource": "/a.ts", "startLineNumber": 1, "startColumn": 1, "severity": 8, "message": "x"}])

    def do_POST(self):
        self.reply({"result": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})

    def log_message(self, *_):
        pass


def call(name, **arguments):
    return server.handle({"method": "tools/call", "params": {"name": name, "arguments": arguments}})


with tempfile.TemporaryDirectory() as tmp:
    server.REGISTRY = pathlib.Path(tmp)
    assert call("get_diagnostics")["isError"]  # no bridge registered

    http = HTTPServer(("127.0.0.1", 0), FakeBridge)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    entry = {"pid": server.os.getpid(), "port": http.server_address[1], "token": TOKEN, "workspaceName": "ws", "folders": ["/ws"]}
    (server.REGISTRY / "1.json").write_text(json.dumps(entry))
    (server.REGISTRY / "2.json").write_text(json.dumps({**entry, "pid": 2**22 + 1}))  # dead pid

    assert [w["workspaceName"] for w in json.loads(call("list_windows")["content"][0]["text"])] == ["ws"]
    assert not (server.REGISTRY / "2.json").exists()

    out = pathlib.Path(tmp) / "diag.json"
    result = json.loads(call("get_diagnostics", workspace="/ws", out=str(out))["content"][0]["text"])
    assert result["total"] == 1 and result["errors"] == 1 and len(json.loads(out.read_text())) == 1
    assert call("get_diagnostics", min_count=2)["isError"]
    assert call("get_diagnostics", workspace="other")["isError"]

    sent = json.loads(call("execute_command", command="a.b", args=[1])["content"][0]["text"])
    assert sent["result"] == {"command": "a.b", "args": [1]}

    assert [t["name"] for t in server.handle({"method": "tools/list"})["tools"]] == list(server.HANDLERS)
    http.shutdown()

print("ok")
