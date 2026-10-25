import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { admitUpgrade, authenticateStart } from "./call-preview.mjs";
import { TrialCall, TRIAL_AGENT, TRIAL_TITLE, TRIAL_CWD } from "./call-preview-runtime.mjs";

const port = Number(process.env.CALL_PREVIEW_PORT ?? 8788);
const metroPort = Number(process.env.CALL_METRO_PORT ?? 8087);
const origin = process.env.CALL_PREVIEW_ORIGIN ?? "https://titanium.tail75866.ts.net:8443";
const origins = [origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`];
const hosts = new Set(origins.map((entry) => new URL(entry).host));
const token = randomBytes(32).toString("hex");
const tokenPath = new URL("../.dev/call-preview-token", import.meta.url);
await mkdir(new URL("../.dev", import.meta.url), { recursive: true });
await writeFile(tokenPath, token, { mode: 0o600 });
const expires = Date.now() + 2 * 60 * 60 * 1000;
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let active = null;
const server = http.createServer((req, res) => {
  if (!hosts.has(req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  if (req.method !== "GET" || req.url?.startsWith("/call-api")) {
    res.writeHead(404).end();
    return;
  }
  // Static development UI only. Never forward daemon or app-server requests.
  const upstream = http.get(
    {
      hostname: "127.0.0.1",
      port: metroPort,
      path: req.url,
      headers: { host: `localhost:${metroPort}` },
    },
    (response) => {
      res.statusCode = response.statusCode ?? 502;
      if (response.headers["content-type"])
        res.setHeader("Content-Type", response.headers["content-type"]);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Call UI is not ready. Start the preview Metro server.");
  });
  res.on("close", () => upstream.destroy());
});
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/call-api" || !admitUpgrade(req.headers, origins) || Date.now() > expires) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
});
sockets.on("connection", (ws) => {
  let call = null;
  let used = false;
  let alive = true;
  const send = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const authDeadline = setTimeout(() => ws.close(1008, "Start authentication required"), 5000);
  const callDeadline = setTimeout(() => ws.close(1000, "Trial call limit reached"), 10 * 60000);
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 10000);
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("message", (raw) => {
    if (used) {
      ws.close(1008, "One start per connection");
      return;
    }
    used = true;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.close(1008, "Invalid request");
      return;
    }
    if (!authenticateStart(message, token) || Date.now() > expires) {
      ws.close(1008, "Invalid or expired trial token");
      return;
    }
    clearTimeout(authDeadline);
    if (active) {
      send({
        type: "error",
        message: "Another trial call is active. End it before calling again.",
      });
      ws.close();
      return;
    }
    if (
      typeof message.sdp !== "string" ||
      message.sdp.length > 40000 ||
      !message.sdp.startsWith("v=0")
    ) {
      ws.close(1008, "Invalid audio offer");
      return;
    }
    call = new TrialCall(send);
    active = call;
    send({
      type: "identity",
      host: "titanium",
      agentId: TRIAL_AGENT,
      title: TRIAL_TITLE,
      cwd: TRIAL_CWD,
    });
    void call.start(message.sdp).catch((error) => {
      call.fail(error.message.startsWith("Call ended") ? "Call ended" : error.message);
    });
  });
  ws.on("error", () => ws.terminate());
  ws.on("close", () => {
    clearTimeout(authDeadline);
    clearTimeout(callDeadline);
    clearInterval(heartbeat);
    call?.stop();
    if (active === call) active = null;
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Call preview on 127.0.0.1:${port}; Metro localhost:${metroPort}`);
  console.log(`Allowed phone origin: ${origin}`);
  console.log(`Scoped token file (not logged): ${tokenPath.pathname}; expires in 2 hours`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    active?.stop();
    for (const ws of sockets.clients) ws.terminate();
    server.close(() => process.exit(0));
  });
}
