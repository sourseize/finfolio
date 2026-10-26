# 💰 BudInv — Investment & Budgeting Application

> A fully self-contained, zero-dependency personal finance SPA built with TypeScript.

Track your accounts, transactions, budgets, investments, and financial goals — all in one sleek dark-themed dashboard. No database server, no external runtime dependencies, no build complexity.

---

## ✨ Features

### 🔐 Authentication
- User registration and login
- Secure SHA-256 password hashing
- Token-based session management (24h expiry)
- Persistent sessions via `localStorage`

### 🏦 Accounts
- Multiple account types: `checking`, `savings`, `investment`, `credit`, `cash`
- Multi-currency support (USD, EUR, GBP, JPY, CHF, BTC, ETH)
- Create, edit, delete accounts
- Real-time balance tracking — transactions auto-update balances

### 💳 Transactions
- Income and expense tracking with categories
- Filter by account, category, date range
- Auto-calculates budget spending when transactions are added
- Supported categories: Food & Dining, Transportation, Housing, Utilities, Entertainment, Shopping, Healthcare, Education, Salary, Freelance, Investment, Gift, Other

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
- **Net worth** (assets − liabilities)
- **Total balance** across all accounts
- **Monthly income** and **monthly expenses**
- **Investment portfolio value**
- **Savings rate** with motivational feedback
- **Doughnut chart** — top expense categories this month
- **Budget health** — per-category spending vs budget
- **Recent transactions** — last 5 entries
- **Goal progress** — snapshot of all goals

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
- Modal-based forms for all CRUD operations
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
       └─ pages-3.js   (goals, reports)
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
cd budinv

# Install dependencies (just TypeScript compiler)
npm install

# Build the TypeScript backend
npm run build

# Start the server
npm start
```

Open **http://localhost:3000** in your browser. Register a new account and start managing your finances.

### Development Mode

```bash
# Run directly with tsx (TypeScript execution via npx)
npm run dev
```

Changes to `src/` files are picked up automatically when you rebuild. Changes to `public/` files are served immediately — no restart needed.

---

## 🧪 Testing

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
cp $(which node) budinv
npx postject budinv NODE_SEA_BLOB sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Now you have a portable binary!
./budinv
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

---

## 📁 Project Structure

```
budinv/
├── src/
│   ├── server.ts            # Entry point — starts HTTP server
│   ├── server/
│   │   └── router.ts        # HTTP router, static file serving, session management
│   ├── db/
│   │   └── database.ts      # JSON file database — all CRUD + dashboard logic
│   └── routes/
│       └── api.ts           # API route handlers
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
│       ├── pages-2.js       # Budgets, Investments
│       └── pages-3.js       # Goals, Reports
├── data/                    # Created at runtime — JSON database
├── dist/                    # Compiled JavaScript output
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

*Built with 💰 by keeping it simple — zero dependencies, maximum control.*
