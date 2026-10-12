# Chit Master Pro

Chit fund management software in three parts:

| Part | Address | Source |
| --- | --- | --- |
| Office software | `/office` | `public/apps/office.html` |
| Member app | `/member` | `public/apps/member.html` |
| Collection agent app | `/agent` | `public/apps/agent.html` |

The React + Vite shell (`src/`) provides the home page and routing. Each part is still a self-contained page and can be moved into React components one screen at a time.

The office software has two modes, chosen on its sign-in page:

- **Online (default):** staff sign in with their own login and work on the company's shared data, kept on the server (`backend/`). The same data shows on every computer. `public/apps/online.js` connects the office screens to the API.
- **This browser only:** the earlier prototype, which keeps data in the browser and is not shared.

Some office features are not online yet (future receipts, post-dated cheques, transfers, member removal, bid advances, vouchers, import and a few more). In online mode they show a message instead of saving. The member and agent apps still show sample data. The hosted version plan is in `docs/`.

## Run locally

```sh
npm install
npm run dev                      # website on http://localhost:5173

cd backend && npm install
npm run db:migrate:local
npm run dev                      # API on http://localhost:8787; the website sends /api there
```

## Build

```sh
npm run build   # output in dist/
```

## Deploy

Import the GitHub repo in Vercel. It detects Vite automatically (build command `npm run build`, output `dist`). `vercel.json` sends every route to the React app.

## Folders

- `docs/`: requirements and design, hosted version plan
- `designs/`: wireframes and the three dashboard looks (reference only, not deployed)
