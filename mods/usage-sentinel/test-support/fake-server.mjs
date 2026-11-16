// 模擬 /api/oauth/usage 的本機 HTTP server。
import { createServer } from 'node:http';

export async function startFakeServer() {
  let reply = { status: 200, body: {}, headers: {} };
  let hanging = false;
  const requests = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (hanging) return; // 永不回應，用來測逾時
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/api/oauth/usage`,
    requests,
    respond(status, body, headers = {}) {
      hanging = false;
      reply = { status, body, headers };
    },
    hang() {
      hanging = true;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
