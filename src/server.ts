import http from 'node:http';
import { db } from './db/database.js';
import { router } from './server/router.js';
import './routes/api.js'; // Side-effect: registers routes

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  await db.init();
  console.log('📦 Database loaded');

  const server = http.createServer((req, res) => router.handle(req, res));

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     📊 FinFolio - Investment & Budgeting    ║
║     Server running at http://localhost:${PORT}  ║
╚══════════════════════════════════════════════╝
    `);
  });
}

main().catch(console.error);
