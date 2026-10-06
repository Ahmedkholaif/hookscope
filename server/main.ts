import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const { server, closeStreams } = createApp({ staticDir });
const port = Number(process.env.PORT ?? 4000);

server.listen(port, () => console.log(`hookscope on http://localhost:${port}`));

// Graceful shutdown: stop accepting connections, tell live browsers to go,
// let in-flight requests finish, then exit (or force it after 10s).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    closeStreams();
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
