# 📊 FinFolio — Investment & Budgeting Application

> A fully self-contained, zero-dependency personal finance SPA built with TypeScript.

Track your accounts, transactions, budgets, investments, and financial goals — and **simulate your future**: life events, economic conditions and spending decisions projected into runway, net worth and financial-independence milestones. No database server, no external runtime dependencies, no build complexity.

---

## ✨ Features

### 🔐 Authentication
- User registration and login
- Secure SHA-256 password hashing
- Token-based session management (24h expiry)
- Persistent sessions via `localStorage`

### 🏦 Accounts
- Multiple account types: `checking`, `savings`, `investment`, `credit`, `cash`
- **Credit accounts hold the amount owed as a positive number** (a liability). Purchases increase it, payments/refunds reduce it; net worth subtracts it
- Multi-currency support (USD, EUR, GBP, JPY, CHF, BTC, ETH)
- Create, edit, delete accounts
- Real-time balance tracking — transactions auto-update balances

### 💳 Transactions
- Income and expense tracking with categories
- Filter by account, category, date range
- Auto-calculates budget spending when transactions are added
- Supported categories: Food & Dining, Transportation, Housing, Utilities, Entertainment, Shopping, Healthcare, Education, Salary, Freelance, Investment, Gift, Transfer, Other, Uncategorized
- Edit any transaction in place (account, type, amount, category, date, description) — balances and budgets follow
- **`Uncategorized`** is where imported statement rows land when no rule recognises them; re-categorise them from the list whenever you like (they count as spending until then)
- **`Transfer`** is money moved between your own accounts (card pay-offs, savings top-ups) — never counted as income or spending. An **`Investment`** expense is money put into investments (saving, not spending); `Investment` income is dividends/interest

### ⬆ Statement import
- Import bank statements as **CSV/TSV** (any bank layout — delimiter, header, columns, date order, number format and sign convention are inferred and can be corrected), **OFX 1.x/2.x & QFX**, **QIF** and **Open Banking JSON** (UK OBIE, Berlin Group, Plaid-style)
- **Duplicate detection** that never guesses: a row is skipped automatically only on a 100 % match (bank transaction id, or same date + amount + description); the same amount and description 1–2 days apart, or an identical row earlier in the same upload, is put in front of you for a **Keep / Skip** decision. Skipping stamps the recorded transaction (🔗) so it is recognised next time
- **Exclusions that protect your data**: rows in another currency than the account, pending rows (unless asked), rows dated after today, unparseable rows — never written
- **Transfer pairing**: the other leg on another account within 3 days → categorised `Transfer`, not flagged as a duplicate
- **Static categorisation** (`config/import-categories.json`: keyword rules, merchant category codes, ISO 20022 bank codes, Quicken/Mint/YNAB/Plaid aliases); anything unknown lands in `Uncategorized` for you to fix from the list
- **Balance reconciliation**: the statement's closing balance next to the computed one, with *keep / set to statement / enter* options
- Remembered CSV mappings per header layout; exact-file detection ("this file was imported on …")
- **Import page wizard**: *Upload & account* → *Mapping* (CSV only, live re-preview) → *Needs attention* (a shrinking Keep / Skip list — rows disappear as you decide, nothing else nags) → *Confirm* (counts, balance reconciliation, one Import button). Reachable from the sidebar, the Transactions page and every account card

### 📋 Budgets
- Monthly, weekly, or yearly budget periods
- Per-category spending limits
- Visual progress bars with color warnings (green → orange → red)
- Real-time spent tracking synced with transactions
- Over-budget alerts

### 📈 Investments
- Portfolio tracking for: stocks, crypto, ETFs, mutual funds, bonds, real estate
- Track shares, average cost, current price
- Realized P&L calculations per holding
- Buy / sell / dividend trade logging
- Transaction history per investment
- Portfolio-level aggregate (total value, total cost, gain/loss %)

### 🎯 Goals
- Set financial goals with target amounts and deadlines
- Priority levels: low, medium, high
- Goal categories: Savings, Debt, Investment, Travel, Education, Retirement, Emergency, House, Car, Other
- Visual progress bars with percentage completion
- Days-remaining countdown

### 📊 Dashboard
- **Net worth** (assets + investments − liabilities)
- **Total balance** across cash & asset accounts, plus total liabilities
- **Monthly income** and **monthly expenses**
- **Investment portfolio value**
- **Savings rate** with motivational feedback
- **Doughnut chart** — top expense categories this month
- **Budget health** — per-category spending vs budget
- **Recent transactions** — last 5 entries
- **Goal progress** — snapshot of all goals

### 🔮 Simulate (forward-looking)
- **Starting point** derived from your real data: cash, investments, debt and the average income / spending / investing of the last 12 complete months — every figure can be overridden ("assume I spend 3 500")
- **Life events** from a catalog of 15 templates: job loss, sabbatical, pay rise / cut, partner income, new child, lifestyle change, relocation, health costs, windfall, big purchase, buying a home (down payment + amortising mortgage, rent replaced), paying off debt, early/late retirement, changing the investing rate — each with a start month and optional duration, in today's money
- **Economic conditions**: presets (moderate, bull, bear, stagflation, lost decade, crash-then-recovery, deflation) or custom return / inflation / wage growth / volatility / cash yield / debt APR, plus scheduled market shocks
- **Projection** month by month to age 90 (or a chosen horizon): net worth, cash, invested, property, debt — nominal or in today's money — with the baseline path overlaid for comparison
- **Monte Carlo**: 300 randomised runs give the 10th–90th percentile band, the chance of never running out of money and the chance of reaching FI before retirement
- **FIRE milestones**: FI number (annual spending ÷ safe-withdrawal rate), Lean FI, Coast FI, FI date and age, progress today
- **Runway**: months of spending covered by cash, by all assets, and a simulated "income stops today" run
- **Goals under this scenario**: whether each goal is funded by its deadline from the projected surplus (priority waterfall)
- **What does it really cost?** — the future value of a one-off or monthly spend if invested instead
- **Save / compare** scenarios side by side (FI date, net worth at retirement and at the end, when money runs out)
- Dashboard cards summarise **Runway** and **Financial independence** on current habits
- Taxes are intentionally out of scope: gains are tax-free and income is take-home

### 📑 Reports
- **Income vs Expenses trend** — 6-month line chart
- **Balance by account** — bar chart
- **Summary statistics** — net worth, balances, savings rate, counts
- **Top expense categories** — this month's breakdown
- **Goal completion** — progress overview

### 🎨 UI / UX
- Dark cyberpunk theme with custom CSS variables
- Responsive layout — sidebar collapses on mobile
- Canvas-based charts (doughnut, bar, line) — zero chart libraries
- Modal-based forms for all CRUD operations; native `<dialog>` confirmations (no browser `confirm()`/`prompt()`)
- Toast notifications for all actions
- Loading states and empty-state placeholders
- Smooth animations and hover effects

---

## 🏗 Architecture

```
┌──────────────────┐     ┌────────────────────┐     ┌──────────────┐
│  Browser (SPA)   │────>│  Node.js HTTP       │────>│  JSON File   │
│  Vanilla JS      │<────│  (built-in http)    │<────│  Database    │
└──────────────────┘     └────────────────────┘     └──────────────┘
       │                          │
       │                          ├─ Router (pattern matching)
       │                          ├─ Auth (token-based sessions)
       │                          └─ API Handlers (CRUD)
       │
       ├─ api.js       (HTTP client)
       ├─ utils.js     (helpers + Chart library)
       ├─ app-core.js  (app shell, auth UI, navigation)
       ├─ page-dashboard.js
       ├─ pages.js     (accounts, transactions)
       ├─ pages-2.js   (budgets, investments)
       ├─ pages-3.js   (goals, reports)
       └─ page-simulate.js (scenario builder, projections, compare)

Server-side simulation engine (src/sim/): baseline → events × economy → engine → FIRE / runway / Monte Carlo / comparison
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Zero runtime dependencies** | Only `typescript` + `@types/node` as dev dependencies. Uses Node's built-in `http`, `fs`, `crypto`, `path` modules. |
| **JSON file database** | Fully portable, no DB server. Stored in `data/database.json`. Backed up by simply copying the file. |
| **Canvas-based charts** | Custom chart rendering (doughnut, bar, line) — no Chart.js or D3 dependency. |
| **SPA with hash routing** | Simple `#hash`-based navigation, no framework needed. |
| **Token auth** | Stateless bearer tokens stored in `localStorage`. |
| **TypeScript** | Full type safety on the backend, compiled to plain JS for distribution. |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 18 (tested on v24)
- **npm** >= 9

### Setup

```bash
# Clone or navigate to the project directory
git clone https://github.com/sourseize/finfolio.git
cd finfolio

# Install dependencies (just TypeScript compiler)
npm install

# Build the TypeScript backend
npm run build

# Start the server
npm start
```

Open **http://localhost:3000** in your browser. Register a new account and start managing your finances.

### Demo user `fin`

```bash
npm run seed                          # creates (or resets) the demo user
npm start                             # sign in as  fin / folio
FINFOLIO_NOW=2026-10-25 npm start     # optional: freeze the clock on the seed date
```

`fin` is a 40-year-old (born 1986-07-10) planning to retire at 65, with 24 months of realistic history ending on **2026-10-25**: salary and freelance income, rent, utilities, groceries, card spending with monthly pay-offs, transfers to savings and a brokerage with monthly ETF purchases, a few one-offs (laptop, car repair, Lisbon holiday), current-month budgets (one over), four goals, a profile and five saved scenarios (*Keep going*, *Buy a flat in 2028*, *Sabbatical + crash*, *Retire at 58*, *Family of four*). The seed is deterministic and re-runnable; the regression suite's golden snapshot is taken from it.

### Development Mode

```bash
# Run directly with tsx (TypeScript execution via npx)
npm run dev
```

Changes to `src/` files are picked up automatically when you rebuild. Changes to `public/` files are served immediately — no restart needed.

---

## 🧪 Testing

### Automated regression suite

The suite uses Node's built-in test runner (`node:test`) — no extra dependencies. It boots the real HTTP server in-process on a random port against a throw-away data directory, with the clock frozen at **2026-10-25** so results are reproducible.

```bash
npm test                  # everything: unit + API + headless UI + golden (~10 s)
npm run test:unit         # pure logic: clock, database, simulation engine (~100 tests)
npm run test:api          # HTTP regression against the in-process server, incl. the fin seed
npm run test:ui           # headless UI: every page rendered with fin's data in a vm-hosted mini-DOM
npm run test:golden       # fin's dashboard, baseline and all five scenarios vs tests/golden/fin.snapshot.json
npm run test:update-golden  # re-baseline the snapshot after an intentional change (review the diff!)
npm run test:watch        # re-run on change
npm run gen:statements    # write the test bank statements to samples/statements/ (see below)
npm run test:smoke        # hotfix gate: the two import journeys through the real UI + page smoke (~10 s incl. compile)
npm run typecheck         # tsc --noEmit for app and tests (strict for tests)
```

Test layout:

```
tests/
├── helpers/
│   ├── server.ts    # launch() → in-process server on a random port, temp data dir, frozen clock
│   ├── sim.ts       # builders for engine inputs with "flat" economies so results are hand-checkable
│   ├── dom.ts       # dependency-free mini-DOM (parser, selectors, events, canvas stubs)
│   └── browser.ts   # loads public/js/*.js into node:vm against the in-process server
├── unit/            # clock, database, sim/*, statement generator, import parsers (round trip + edge cases), dedupe engine, categoriser
├── api/             # auth, CRUD, simulation routes, seed, statement import (every scenario over HTTP)
├── ui/              # headless page smoke + interactions (modals, builder, save/compare), import wizard smoke (SMOKE-1/2)
└── golden/          # fin.snapshot.json + the test that diffs against it
```

The headless UI harness is not a browser (no CSS or layout); it catches runtime errors and checks that API data lands in the HTML.

### Test bank statements

`npm run gen:statements` renders twelve import scenarios from the demo user's data into
`samples/statements/` (git-ignored) — the same files the regression suite parses in memory:

| Scenario | What it exercises |
|---|---|
| S1 clean · S2 same statement in other formats | exact copies of `fin`'s September checking statement: CSV (US/UK), OFX 1.x/2.x, QFX, QIF (three date styles), Open Banking JSON (UK OBIE, Berlin Group, Plaid-style); S2 adds bank-style noise (POS prefixes, masked card numbers, references, embedded dates) and carried categories/MCCs |
| S3 overlap + catch-up | a 20 Sep – 25 Oct window overlapping S1, with six October rows `fin` never entered — the file to use to see rows *imported into the demo user* |
| S4 near-duplicates · S5 repeats | planted rows around the 2-day rule, a verbatim repeat, two same-amount coffees |
| S6 foreign currency · S7 pending | EUR rows on a USD statement, a GBP file, pending rows |
| S8 messy CSV | preamble lines, BOM, CRLF, quoted newlines, `(1,234.56)`, DR/CR, German `;`/`1.234,56`, UTF-16, ambiguous DD/MM dates |
| S9 transfer pair · S10 credit card | checking + card for the same month; a card statement alone |
| S11 invalid | garbage, empty, truncated OFX, brokerage QIF/OFX, JSON without transactions |
| S12 fresh account | three months for an account not in the demo data |

Every file ships with its expected import outcome in `samples/statements/README.md`. The
generator (`src/testing/statements/`) is also what the round-trip tests use: each file is
parsed back by `src/import/` and compared field by field with the statement it was written from.

### Manual API walkthrough

The application has been tested with the full API surface. Here's a manual test sequence:

```bash
# Start the server
npm start

# 1. Register a user
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo123"}'

# Save the token from the response

# 2. Create accounts
curl -X POST http://localhost:3000/api/accounts \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"Checking","type":"checking","balance":5000}'

curl -X POST http://localhost:3000/api/accounts \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"Savings","type":"savings","balance":10000}'

# 3. Add a transaction
curl -X POST http://localhost:3000/api/transactions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"accountId":"<account-id>","type":"expense","amount":45.50,"category":"Food & Dining","description":"Lunch"}'

# 3b. Edit it (any subset of accountId, type, amount, category, date, description, tags)
curl -X PUT http://localhost:3000/api/transactions/<txn-id> \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"category":"Food & Dining","description":"Lunch with team"}'

# 4. Create a budget
curl -X POST http://localhost:3000/api/budgets \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"category":"Food & Dining","amount":800,"period":"monthly"}'

# 5. Add an investment
curl -X POST http://localhost:3000/api/investments \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"symbol":"AAPL","name":"Apple Inc.","type":"stock","shares":10,"avgCost":150,"currentPrice":175}'

# 6. Set a goal
curl -X POST http://localhost:3000/api/goals \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"Emergency Fund","targetAmount":15000,"currentAmount":5000,"category":"Savings","priority":"high"}'

# 7. View dashboard
curl http://localhost:3000/api/dashboard \
  -H 'Authorization: Bearer <token>' | python3 -m json.tool
```

### Simulation API

All routes except `/api/simulate/catalog` require a bearer token. Money in scenario events is expressed in **today's money**; the engine inflates it. Taxes are out of scope (gains are tax-free, income is take-home).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/simulate/catalog` | Economy presets, life-event templates, defaults (public) |
| `GET` / `PUT` | `/api/profile` | Birth date, retirement age, safe-withdrawal rate, plan-to age |
| `GET` | `/api/simulate/baseline?lookback=12` | Starting point derived from your accounts and the last *N* complete months |
| `POST` | `/api/simulate` | Run an inline scenario (`{ scenario, montecarlo?, includeMonths?, lookback? }`) or `{ scenarioId }`; omit both for the baseline |
| `POST` | `/api/simulate/compare` | `{ scenarios: [ … ] }` (inline or `{ id }`) → results + deltas vs the first |
| `POST` | `/api/simulate/opportunity-cost` | `{ oneOff?, monthly?, years, annualReturn?, inflation? }` → future value of a spending decision |
| `GET` | `/api/simulate/outlook` | Compact runway / FIRE numbers for the dashboard |
| `GET` / `POST` | `/api/scenarios` | List / save scenarios |
| `GET` / `PUT` / `DELETE` | `/api/scenarios/:id` | Manage a saved scenario |
| `GET` | `/api/scenarios/:id/run?montecarlo=1&trials=500&seed=42&months=0` | Run a saved scenario |

Example — a sabbatical in a bear market with Monte Carlo:

```bash
curl -X POST http://localhost:3000/api/simulate \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' \
  -d '{"scenario":{"name":"Year off","horizonYears":20,"economy":{"preset":"pessimistic"},
       "events":[{"kind":"income","label":"Sabbatical","startMonth":12,"durationMonths":12,"percent":-1}]},
       "montecarlo":{"trials":500,"seed":42},"includeMonths":false}'
```

The response contains `baseline`, `profile`, the normalised `scenario`, `result` (`months`, `yearly`, `summary` with `fire` and `runway`), `montecarlo` (P10–P90 bands, success and FI probabilities) and `goals` feasibility.

### Statement import API

All routes except `/api/import/formats` require a bearer token. Files travel as base64 inside JSON (25 MB request cap).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/import/formats` | Supported formats, categories, dedupe thresholds, limits (public) |
| `POST` | `/api/import/preview` | `{ accountId, localeHint?, files: [{ name, content }], options?: { includePending?, mappings?: { [fileIndex]: { dateOrder?, numberFormat?, delimiter?, headerRow?, columns?, signConvention? } } } }` → `previewId`, per-file facts (format, detected account/currency/period/closing balance, CSV mapping, exact-file banner, currency block, parse error), `rows[]` with `status: new | recorded | possible | excluded`, the matched transaction and rule (`R1 R2 P1 P2`), category and source, transfer pairing; `summary`; `balance` |
| `POST` | `/api/import/preview` | `{ previewId, accountId?, options? }` — re-run on the cached upload (mapping / pending toggle / other account) |
| `POST` | `/api/import/commit` | `{ previewId, decisions: { [rowIdx]: "keep" \| "skip" }, balance?: { mode: "keep" \| "statement" \| "manual", value? }, saveProfile? }` → batch ids, counts, final balance. `409` while a *possible* row is undecided, `410` when the preview expired |
| `GET` / `DELETE` | `/api/import/profiles[/:id]` | Remembered CSV mappings |

Black-box client (same API the browser uses):

```bash
npm run import:file -- --file samples/statements/S4/everyday-checking-2026-09.ofx1.ofx --account "Everyday Checking"
npm run import:file -- --user qa --password qa-pass --account "QA Checking" --file statement.csv --locale en-GB --commit --decide skip --balance statement
```

Categorisation and the dedupe windows are data, not code: edit `config/import-categories.json` (or point `FINFOLIO_IMPORT_CONFIG` at your own copy). The server validates it at startup and refuses to start on an unknown category or a broken pattern.

The step-by-step manual validation suite is in `docs/IMPORT_TEST_SUITE.md`.

### Build Verification

```bash
# TypeScript compilation check (no emit)
npx tsc --noEmit

# Full build
npm run build

# Verify output
ls dist/
# Should show: db/  routes/  server/  server.js  server.js.map
```

---

## 📦 Shipping / Deployment

### Production Build

```bash
# Clean build
rm -rf dist data
npm run build

# Start
NODE_ENV=production PORT=3000 node dist/server.js
```

### As a Single-File Binary (using `sea` — Node.js Single Executable Applications)

Node.js v20+ supports bundling into a standalone executable:

```bash
# Build the JS output
npm run build

# Create a blob
node --experimental-sea-config sea-config.json

# Copy node binary and inject the blob
cp $(which node) finfolio
npx postject finfolio NODE_SEA_BLOB sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Now you have a portable binary!
./finfolio
```

### Docker (optional)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ dist/
COPY public/ public/
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `FINFOLIO_DATA_DIR` | `./data` | Directory holding `database.json` |
| `FINFOLIO_NOW` | *(system clock)* | Freeze "today" (e.g. `2026-10-25`). Used by the regression suite and demo data; leave unset in normal use |
| `FINFOLIO_MAX_BODY_MB` | `25` | Largest accepted request body (statement uploads travel as base64 inside JSON); larger requests get `413` |
| `FINFOLIO_IMPORT_CONFIG` | `./config/import-categories.json` | Categorisation rules and dedupe windows for statement import (falls back to the compiled-in defaults when the file is missing) |

---

## 📁 Project Structure

```
finfolio/
├── src/
│   ├── server.ts            # Entry point — starts HTTP server
│   ├── server/
│   │   └── router.ts        # HTTP router, static file serving, session management
│   ├── db/
│   │   └── database.ts      # JSON file database — all CRUD + dashboard logic
│   ├── routes/
│   │   ├── api.ts           # CRUD route handlers
│   │   └── simulate.ts      # profile, scenarios, simulation routes
│   ├── sim/                 # simulation engine (pure, deterministic)
│   ├── seed/                # demo user "fin" generator + CLI
│   └── util/clock.ts        # frozen-clock support (FINFOLIO_NOW)
│   ├── import/              # statement import: parsers (CSV, OFX/QFX, QIF, Open Banking JSON), dedupe engine, categoriser, config, sessions
│   ├── testing/             # test-statement generator (statements/), gen:statements and import:file CLIs
│   └── routes/import.ts     # preview / commit / profiles routes
├── config/
│   └── import-categories.json  # categorisation rules, MCC ranges, aliases, dedupe windows (editable)
├── docs/                    # IMPORT_WORKBOOK.md (design, work packages) · IMPORT_TEST_SUITE.md (manual validation)
├── public/
│   ├── index.html           # SPA shell
│   ├── css/
│   │   └── style.css        # Full dark theme
│   └── js/
│       ├── api.js           # HTTP client (fetch wrapper)
│       ├── utils.js         # Helpers + Chart library (canvas)
│       ├── app-core.js      # App shell, auth, navigation
│       ├── page-dashboard.js
│       ├── pages.js         # Accounts, Transactions
│       ├── page-import.js   # Statement import wizard
│       ├── pages-2.js       # Budgets, Investments
│       ├── pages-3.js       # Goals, Reports
│       └── page-simulate.js # Simulate
├── tests/                   # regression suite (node:test, zero dependencies)
├── samples/                 # Created by gen:statements — test bank statements (git-ignored)
├── data/                    # Created at runtime — JSON database
├── dist/                    # Compiled JavaScript output
├── Dockerfile
├── sea-config.json
├── tsconfig.json
├── package.json
└── .gitignore
```

---

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| **Language** | TypeScript 5.x |
| **Runtime** | Node.js 18+ (built-in `http`, `fs`, `crypto`) |
| **Backend** | Custom HTTP router with pattern matching |
| **Database** | JSON file (`data/database.json`) |
| **Frontend** | Vanilla JavaScript SPA |
| **Charts** | Custom canvas rendering (zero dependencies) |
| **Styling** | CSS with custom properties (dark theme) |
| **Build** | TypeScript compiler only |

---

## 📄 License

MIT — free to use, modify, and distribute.

---

*Built with 📊 by keeping it simple — zero dependencies, maximum control.*
