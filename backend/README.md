# Chit Master Pro API

The backend: a Cloudflare Worker with a Cloudflare D1 database. The website on Vercel sends every `/api/...` request here (see `vercel.json`), so the site and the API share one address: https://chits-software.vercel.app/api/health.

D1 is for development and testing. Before real member data goes in, decide whether the data must stay in India (D1 cannot guarantee an Indian region). If it must, the same tables move to PostgreSQL in Mumbai through Cloudflare Hyperdrive.

## What it does

- **Sign in** with a user name and password. Passwords are stored only as salted hashes. A session ends after 2 hours without use or 12 hours in all. Five wrong passwords lock the login for 15 minutes.
- **Five roles**: Owner, Manager, Accountant, Collection agent, Viewer. Permissions are checked on the server for every request. A collection agent sees and collects only for the tickets assigned to them.
- **Members, groups, enrollment, auctions, receipts, prize payments**, following the rules in `docs/requirements-and-design.md`.
- **Books kept as you go**: every auction, receipt and prize payment saves its own balanced voucher in the same step, so the trial balance always matches the records. A cancelled receipt or payment stays on record with its voucher marked cancelled.
- **Audit trail**: every create, change and cancel records who did it, when, and the old and new values.
- **Reports**: account copy, outstanding and defaulters, collection register, auction chart, prize payments, trial balance, day book.

Money is sent and returned in **whole paise** (Rs 21,250 is `2125000`), and percentages in **basis points** (5% is `500`).

## Endpoints

| | |
| --- | --- |
| `GET /api/health` | Is the database reachable (no sign-in) |
| `POST /api/setup` | Create a company with its roles, accounts and owner login. Needs the `x-setup-key` header |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Sign in and out. Send the token as `Authorization: Bearer <token>` |
| `GET/POST /api/users`, `PATCH /api/users/:id`, `GET /api/roles`, `GET /api/sign-ins` | Staff logins, unlock, reset password, sign-in history |
| `GET/POST /api/persons`, `GET/PATCH /api/persons/:id` | Members, agents, guarantors |
| `GET/POST /api/groups`, `GET/PATCH /api/groups/:id` | Chit groups; the detail includes every ticket with its status and balance |
| `POST /api/enrollments`, `GET /api/enrollments/:id/account` | Give a ticket; a ticket's account copy |
| `POST /api/auctions/preview`, `POST /api/auctions` | Work out or record an auction |
| `POST /api/receipts`, `GET /api/receipts/:id`, `POST /api/receipts/:id/cancel` | Receipts |
| `POST /api/prize-payments`, `POST /api/prize-payments/:id/cancel` | Pay a prize, optionally keeping back the winner's dues |
| `GET /api/reports/outstanding`, `collections`, `auction-chart`, `prize-payments`, `trial-balance`, `day-book` | Reports |
| `GET /api/audit` | Audit trail |

## Testing

```sh
npm test                    # calculations against the worked example
```

`scripts/scenario.mjs` runs a whole group through the API and checks every report, the accounts and the audit trail: 76 checks. It creates a new test company each time it runs.

```sh
# on your computer
npm run db:migrate:local
npm run dev                                   # in one terminal
SETUP_KEY=<from .dev.vars> npm run scenario   # in another

# against the live site
API_URL=https://chits-software.vercel.app SETUP_KEY=<from setup-key.local.txt> npm run scenario
```

The test logins it creates are saved to `test-logins.local.txt`, which is not committed.

## One-time Cloudflare setup (already done for chit-master-dev)

1. `npm install`, then `npx wrangler login`
2. `npx wrangler d1 create chit-master-dev --location apac`, and put the printed id in `wrangler.jsonc`
3. `npm run db:migrate:remote`
4. `npx wrangler secret put SETUP_KEY` and keep the key somewhere safe
5. `npm run deploy`

For working on your own computer, put `SETUP_KEY=<any long random text>` in `.dev.vars` (not committed).

## Changing the tables

Never edit a migration that has already been applied. Add a new numbered file:

```sh
npx wrangler d1 migrations create chit-master-dev add_something
npm run db:migrate:local      # try it
npm run db:migrate:remote     # then apply it to the cloud database
```

## How the data is stored

- **Several companies in one database.** Every business table has `company_id`.
- **Nothing is erased.** Receipts, auctions and payments are cancelled, never deleted.

| Area | Tables |
| --- | --- |
| Company and staff | `companies`, `branches`, `roles`, `users`, `sessions`, `sign_ins`, `lookup_values`, `counters` |
| People | `persons`, `person_addresses`, `member_logins` |
| Groups | `chit_groups`, `group_deposits` |
| Tickets | `enrollments`, `ticket_transfers`, `member_removals` |
| Auctions | `auctions`, `auction_bids`, `bid_advances`, `prize_payments` |
| Collections | `receipts`, `receipt_installments`, `future_receipts`, `future_receipt_adjustments`, `post_dated_cheques`, `cash_denominations`, `follow_up_calls` |
| Agents | `agent_commission_rules` |
| Accounts | `ledger_accounts`, `bank_accounts`, `vouchers`, `voucher_lines` |
| Audit | `audit_log` |

Field-by-field comments are in `migrations/`.
