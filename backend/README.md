# Chit Master Pro API

The backend: a Cloudflare Worker with a Cloudflare D1 database. It is at an early stage: the database tables are in place, and the API only has a health check and a read-only list of groups. There are no logins yet, so use **test data only**.

D1 is for development. Before real member data goes in, decide whether the data must stay in India (D1 cannot guarantee an Indian region). If it must, the same tables move to PostgreSQL in Mumbai through Cloudflare Hyperdrive.

## One-time Cloudflare setup

Run these from this `backend/` folder.

1. **Create a Cloudflare account** at dash.cloudflare.com if you do not have one. The free plan is enough to start.
2. **Install the tools**
   ```sh
   npm install
   ```
3. **Log in to Cloudflare**. This opens your browser.
   ```sh
   npx wrangler login
   ```
4. **Create the database**
   ```sh
   npx wrangler d1 create chit-master-dev --location apac
   ```
   It prints a `database_id`. Paste it into `wrangler.jsonc` in place of the zeros.
5. **Create the tables in the cloud database**
   ```sh
   npm run db:migrate:remote
   npm run db:seed:remote      # optional: the demo group from the worked example
   ```
6. **Deploy the API**
   ```sh
   npm run deploy
   ```
   It prints a URL like `https://chit-master-api.<your-name>.workers.dev`. Open `/api/health` on it to check.

## Working on your own computer

No Cloudflare login is needed for this.

```sh
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev                 # http://localhost:8787/api/health
```

## Changing the tables

Never edit a migration that has already been applied. Add a new numbered file instead:

```sh
npx wrangler d1 migrations create chit-master-dev add_something
```

Then run `npm run db:migrate:local` to try it, and `npm run db:migrate:remote` once it is right.

## How the data is stored

The rules for every table:

- **Several companies in one database.** Every business table has `company_id`.
- **Money is in whole paise.** ₹1 = 100, so ₹21,250 is stored as `2125000`. Amounts are never stored with decimals.
- **Percentages are basis points.** 1% = 100, so 5% commission is `500` and 18% GST is `1800`.
- **Nothing is erased.** Receipts, auctions and payments are cancelled or reauctioned, and every change goes into `audit_log`.

| Area | Tables | Holds |
| --- | --- | --- |
| Company and staff | `companies`, `branches`, `roles`, `users`, `sign_ins`, `lookup_values`, `counters` | Company settings, logins and permissions, dropdown lists, running numbers |
| People | `persons`, `person_addresses`, `member_logins` | Members, agents and guarantors (one person can be all three), their three addresses, customer app logins |
| Groups | `chit_groups`, `group_deposits` | Chit amount, tickets, commission, bid ceiling, GST, late fee and dividend rules, auction setup, FDR/DD |
| Tickets | `enrollments`, `ticket_transfers`, `member_removals` | Who holds each ticket, agents, guarantors, nominee, transfers, removals and refunds |
| Auctions | `auctions`, `auction_bids`, `bid_advances`, `prize_payments` | Winner and bid with the prize and dividend figures, live room bids, advances, prize paid |
| Collections | `receipts`, `receipt_installments`, `future_receipts`, `future_receipt_adjustments`, `post_dated_cheques`, `cash_denominations`, `follow_up_calls` | Receipts and the installments they paid, money taken before a group starts, PDCs, cash counts, calls to make and promises to pay |
| Agents | `agent_commission_rules` | Commission and TDS rates |
| Accounts | `ledger_accounts`, `bank_accounts`, `vouchers`, `voucher_lines` | Chart of accounts and balanced double-entry vouchers |
| Audit | `audit_log` | Who changed what and when, with old and new values |

The database itself enforces two rules: a ticket can have only one active holder, and a ticket can win only once.

The full definitions, with a comment on each field, are in `migrations/0001_initial_schema.sql`.
