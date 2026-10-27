/**
 * `npm run seed` — create or reset the demo user "fin" (password "folio").
 *
 * Respects FINFOLIO_DATA_DIR. Data is generated relative to the fixed seed
 * date 2026-10-25; start the server with FINFOLIO_NOW=2026-10-25 to see it
 * exactly as intended (or without it to see it against the real clock).
 */
import { db } from '../db/database.js';
import { seedFin, FIN_USERNAME, FIN_PASSWORD, FIN_SEED_DATE } from './fin.js';

async function main() {
  await db.init();
  const summary = await seedFin(db);
  console.log(`
✅ Seeded demo user "${FIN_USERNAME}" (password "${FIN_PASSWORD}") into ${db.filePath}
   as of ${FIN_SEED_DATE}: ${summary.accounts} accounts, ${summary.transactions} transactions, ${summary.investments} holdings / ${summary.trades} trades,
   ${summary.budgets} budgets, ${summary.goals} goals, ${summary.scenarios} saved scenarios.

   npm start                      # sign in as fin / folio
   FINFOLIO_NOW=${FIN_SEED_DATE} npm start   # with the clock frozen at the seed date
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
