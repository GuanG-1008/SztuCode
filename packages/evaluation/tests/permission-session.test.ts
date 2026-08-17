import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { parsePermissionMode, withDaemonPermission } from "../src/permission-session.js";

test("permission mode parser requires explicit auto authorization only for runs", () => {
  assert.equal(parsePermissionMode([]), "accept_edits");
  assert.equal(parsePermissionMode(["--permission-mode", "plan"]), "plan");
  assert.equal(parsePermissionMode(["--permission-mode", "auto"], false), "auto");
  assert.throws(() => parsePermissionMode(["--permission-mode", "auto"]), /requires --allow-auto-permissions/);
  assert.throws(() => parsePermissionMode(["--permission-mode", "invalid"]), /invalid permission mode/);
});

test("daemon permission session restores the original mode after failure", async () => {
  let mode = "normal";
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); index = buffer.indexOf("\n");
        const result = request.method === "settings.get" ? { settings: { permission_mode: mode } } : request.method === "permission.set_mode" ? (mode = request.params.mode, { ok: true, mode }) : {};
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
  const address = server.address();
  try {
    assert.ok(address && typeof address === "object");
    await assert.rejects(() => withDaemonPermission("127.0.0.1", address.port, 2, "auto", async () => { assert.equal(mode, "auto"); throw new Error("runner failed"); }), /runner failed/);
    assert.equal(mode, "normal");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
