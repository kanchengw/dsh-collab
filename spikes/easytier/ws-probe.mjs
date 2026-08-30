import { createHash } from "node:crypto";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
const port = Number(option("--port", "0"));

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be a valid TCP port");
}

if (command === "server") {
  const server = new WebSocketServer({ host: "0.0.0.0", port, perMessageDeflate: false });
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (!isBinary && data.toString() === "__dsh_collab_close__") {
        socket.close(4101, "owner-stopped");
        return;
      }
      socket.send(data, { binary: isBinary });
    });
  });
  server.on("listening", () => process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`));
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
} else if (command === "client") {
  const url = option("--url");
  const payloadBytes = Number(option("--payload-bytes", String(4 * 1024 * 1024)));
  const timeoutMs = Number(option("--timeout-ms", "15000"));
  if (!url || !Number.isSafeInteger(payloadBytes) || payloadBytes < 1) throw new Error("client probe options are invalid");
  const payload = Buffer.alloc(payloadBytes);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  const socket = new WebSocket(url, { perMessageDeflate: false });
  let state = "opening";
  const timeout = setTimeout(() => socket.terminate(), timeoutMs);
  socket.on("open", () => {
    state = "text";
    socket.send("collab-probe");
  });
  socket.on("message", (data, isBinary) => {
    if (state === "text") {
      if (isBinary || data.toString() !== "collab-probe") throw new Error("text echo mismatch");
      state = "binary";
      socket.send(payload);
      return;
    }
    if (state === "binary") {
      const received = Buffer.from(data);
      const actualHash = createHash("sha256").update(received).digest("hex");
      if (!isBinary || received.length !== payload.length || actualHash !== expectedHash) throw new Error("binary echo mismatch");
      state = "closing";
      socket.send("__dsh_collab_close__");
    }
  });
  socket.on("close", (code, reason) => {
    clearTimeout(timeout);
    if (state !== "closing" || code !== 4101 || reason.toString() !== "owner-stopped") {
      process.stderr.write(`unexpected close: state=${state} code=${code} reason=${reason.toString()}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, payloadBytes, payloadHash: expectedHash, closeCode: code, closeReason: reason.toString() })}\n`);
  });
  socket.on("error", (error) => {
    clearTimeout(timeout);
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
} else {
  throw new Error("Expected server or client command");
}
