# Chit Master Pro API

The backend: a Cloudflare Worker with a Cloudflare D1 database. The website on Vercel sends every `/api/...` request here (see `vercel.json`), so the site and the API share one address: https://chits-software.vercel.app/api/health. The office screens use it in online mode through `public/apps/online.js`.

D1 is for development and testing. Before real member data goes in, decide whether the data must stay in India (D1 cannot guarantee an Indian region). If it must, the same tables move to PostgreSQL in Mumbai through Cloudflare Hyperdrive.

## What it does

- **Sign in** with a user name and password. Passwords are stored only as salted hashes. A session ends after 2 hours without use or 12 hours in all. Five wrong passwords lock the login for 15 minutes.
- **Five roles**: Owner, Manager, Accountant, Collection agent, Viewer. Permissions are checked on the server for every request. A collection agent sees and collects only for the tickets assigned to them.
- **Members, groups, enrollment, auctions, receipts, prize payments**, following the rules in `docs/requirements-and-design.md`.
- **Books kept as you go**: every auction, receipt and prize payment saves its own balanced voucher in the same step, so the trial balance always matches the records. A cancelled receipt or payment stays on record with its voucher marked cancelled.
- **Audit trail**: every create, change and cancel records who did it, when, and the old and new values.
- **Member app**: the office issues each member a login (the member number and a 6-digit temporary password, changed at the first sign-in). A member sees only their own tickets, receipts, auctions and prize money. Member sessions last up to 30 days (15 days without use); five wrong passwords lock the login for 15 minutes. Member and staff tokens do not work on each other's routes.
- **Software provider console** (Rugged Customs, `/apps/admin.html`): sign-in needs a password and a 6-digit code from an authenticator app; sessions end after 30 minutes without use or 8 hours. The owner admin creates companies (each with a short code for website links, an owner login with a temporary password, plan, licence date and branding) and manages other admins; a support admin sees companies and usage and can give a company owner a new temporary password. The console never sees a company's members, receipts or accounts. Everything it does is in its own activity log.
- **Licences**: a suspended or closed company cannot sign in. After its licence date it can look but not change anything for its read-only days (7 to 15, set per company), then it is blocked until renewed.
- **Company sign-in links**: `/apps/office.html?co=<code>` and `/apps/member.html?co=<code>` open that company's own sign-in page with its logo and name. A session belongs to its company; a link for another company asks to sign in again.
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
| `GET /api/sync`, `PATCH /api/settings` | Everything the office screens need in one request; the company's shared settings |
| `GET/POST /api/member-logins`, `POST /api/member-logins/bulk`, `PATCH/DELETE /api/member-logins/:id` | Member app logins: list, issue or reset (returns the temporary password once), issue to every enrolled member without one, switch off or unlock, remove |
| `POST /api/member/login`, `POST /api/member/logout`, `POST /api/member/password`, `GET /api/member/home` | The member app: sign in, sign out, change password, and the member's own chits, installments, auctions, receipts and prize money (in rupees) |
| `GET /api/brand?co=<code>` | Name, logo and colours for a company's sign-in page (no sign-in) |
| `POST /api/auth/password` | A staff member sets their own password (needed first after a temporary one) |
| `POST /api/platform/setup` | Create a console owner admin. Needs the `x-setup-key` header |
| `POST /api/platform/login`, `/logout`, `GET /api/platform/me`, `POST /api/platform/password` | Console sign-in with password and authenticator code |
| `GET/POST /api/platform/companies`, `PATCH /api/platform/companies/:id`, `POST /api/platform/companies/:id/reset-owner` | Companies, licences, branding; a new temporary owner password |
| `GET/POST /api/platform/admins`, `PATCH /api/platform/admins/:id`, `GET /api/platform/audit` | Console admins and the console's activity log |
| `PATCH /api/receipts/:id`, `/api/auctions/:id`, `/api/prize-payments/:id` | Change only the extra details (print count, SMS sent), never an amount |
| `DELETE /api/persons/:id`, `/api/groups/:id`, `/api/enrollments/:id`, `PATCH /api/enrollments/:id` | Delete only what nothing depends on; change a ticket's agents and nominee |

## First console admin

Once, after the database has migration 0005:

```sh
curl -X POST https://chits-software.vercel.app/api/platform/setup \
  -H "x-setup-key: <from setup-key.local.txt>" -H "content-type: application/json" \
  -d '{"name":"Your name","username":"your-user-name","password":"<10+ characters, letters and numbers>"}'
```

Then open `/apps/admin.html`, sign in, and scan the code shown with an authenticator app. Further admins (such as a support person) are added from the console.

## Testing

```sh
npm test                    # calculations against the worked example
```

`scripts/scenario.mjs` runs a whole group through the API and checks every report, the accounts, the audit trail, the member app, the provider console and licences: 136 checks. It creates a new test company each time it runs.

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
6. Connected to GitHub with Workers Builds (Settings, Builds): root directory `backend`, build command `npm ci`, deploy command `npx wrangler d1 migrations apply chit-master-dev --remote && npx wrangler deploy`. From then on, every push to `main` applies new migrations and deploys. The build token needs D1 Edit permission.

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
| People | `persons`, `person_addresses`, `member_logins`, `member_sessions` |
| Groups | `chit_groups`, `group_deposits` |
| Tickets | `enrollments`, `ticket_transfers`, `member_removals` |
| Auctions | `auctions`, `auction_bids`, `bid_advances`, `prize_payments` |
| Collections | `receipts`, `receipt_installments`, `future_receipts`, `future_receipt_adjustments`, `post_dated_cheques`, `cash_denominations`, `follow_up_calls` |
| Agents | `agent_commission_rules` |
| Accounts | `ledger_accounts`, `bank_accounts`, `vouchers`, `voucher_lines` |
| Audit | `audit_log` |
| Software provider | `platform_admins`, `platform_sessions`, `platform_audit` |

Field-by-field comments are in `migrations/`.
