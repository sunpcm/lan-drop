import http from 'node:http';
import { resolveConfig, localIPv4Addresses } from './config.js';
import { createApp } from './app.js';

export async function main() {
  const config = resolveConfig();
  const app = await createApp({ config });
  const server = http.createServer(app.handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const actualPort = server.address().port;
  const addresses = localIPv4Addresses();
  console.log('LAN Drop / 隔空小站 已启动');
  console.log(`访问码：${app.auth.accessCode}`);
  for (const address of addresses) {
    console.log(`  http://${address}:${actualPort}`);
  }
  console.log(`  本机：http://127.0.0.1:${actualPort}`);
  console.log(`数据目录：${config.dataDir}`);

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      server.close(async () => {
        await app.close();
        process.exit(0);
      });
      server.closeIdleConnections?.();
    });
  }
  return { app, server, port: actualPort };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
