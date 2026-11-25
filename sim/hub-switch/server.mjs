// G4.4 stand-in for the app (hub-app / hub-app-tailnet run `node server.mjs` from the release): its port from
// the env file, /api/build and /api/token (voice available) as the health check asks them
import http from "node:http";
const port = Number(process.env.PORT);
http.createServer((q, r) => {
  const body = q.url === "/api/build" ? { build: process.env.STUB_BUILD || "stub", auth: process.env.BIFROST_AUTH }
    : q.url === "/api/token" ? { available: true } : null;
  r.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  r.end(JSON.stringify(body || { error: "no route" }));
}).listen(port, "127.0.0.1", () => console.log(`app stub: up on 127.0.0.1:${port} (${process.env.BIFROST_AUTH})`));
