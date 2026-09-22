import { createApp } from './app';
import { readConfig } from './config';

async function main() {
  const config = readConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  console.log(`E-Repetitor API listening on ${config.host}:${config.port}`);
}
main().catch(() => {
  console.error('API startup failed. Check the configured database, migrations and environment.');
  process.exitCode = 1;
});
