import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { db } from './db/database.js';
import { router } from './server/router.js';
import { isClockFrozen, setClock, today } from './util/clock.js';
import { loadImportConfig, resolveImportConfigPath } from './import/config.js';
import './routes/api.js'; // Side-effect: registers routes
import './routes/simulate.js';
import './routes/import.js';
import './routes/motivation.js';

export interface StartOptions {
  /** TCP port. Use 0 to let the OS pick a free port (tests). Default: $PORT or 3000. */
  port?: number;
  /** Directory holding database.json. Default: $FINFOLIO_DATA_DIR or ./data. */
  dataDir?: string;
  /** Suppress the startup banner. */
  quiet?: boolean;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Boot the application: load the database and start listening.
 * Returns a handle that can be used to shut the server down again, which is
 * what the regression suite uses to run the real HTTP stack in-process.
 */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? parseInt(process.env.PORT || '3000', 10);

  await db.init(opts.dataDir);
  loadImportConfig(); // fail fast on a broken categorisation config

  const server = http.createServer((req, res) => router.handle(req, res));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://localhost:${actualPort}`;

  if (!opts.quiet) {
    console.log('📦 Database loaded from', db.filePath);
    console.log('🏷️  Import categories from', resolveImportConfigPath());
    if (isClockFrozen()) console.log(`⏰ Clock frozen at ${today()} (--now / FINFOLIO_NOW)`);
    console.log(`
╔══════════════════════════════════════════════╗
║     📊 FinFolio - Investment & Budgeting    ║
║     Server running at ${baseUrl.padEnd(22)} ║
╚══════════════════════════════════════════════╝
    `);
  }

  return {
    server,
    port: actualPort,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

// Only auto-start when executed directly (`node dist/server.js`), not when imported by tests.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

/**
 * `--now=YYYY-MM-DD` (or `--now YYYY-MM-DD`) freezes the clock like FINFOLIO_NOW does, but works
 * on every shell: `npm start -- --now=2026-11-30`. (`FINFOLIO_NOW=… npm start` is a Unix-only syntax.)
 */
export function nowFromArgs(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--now=')) return a.slice('--now='.length);
    if (a === '--now' && argv[i + 1]) return argv[i + 1];
  }
  return null;
}

if (isDirectRun) {
  const now = nowFromArgs(process.argv.slice(2));
  if (now) setClock(now);
  startServer().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
