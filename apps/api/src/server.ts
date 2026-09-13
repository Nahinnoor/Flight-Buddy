/**
 * Process entry point: load the environment, build the app, listen, and shut
 * down cleanly when the platform says to.
 *
 * A bad environment fails here, before the socket opens, and prints variable
 * *names* only — never values (§12.5).
 */
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

  // SIGTERM is what Render sends on deploy. Draining in-flight requests first
  // is the difference between a rolling deploy and a handful of 502s.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // No logger yet, and nothing secret in the message: it names variables.
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
