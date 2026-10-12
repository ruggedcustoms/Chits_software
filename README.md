# Chit Master Pro

Chit fund management software in three parts:

| Part | Address | Source |
| --- | --- | --- |
| Office software | `/office` | `public/apps/office.html` |
| Member app | `/member` | `public/apps/member.html` |
| Collection agent app | `/agent` | `public/apps/agent.html` |

The React + Vite shell (`src/`) provides the home page and routing. Each part is still a self-contained page and can be moved into React components one screen at a time.

The prototype stores its data in the browser (localStorage), so data does not move between browsers or devices. The hosted version plan is in `docs/`.

## Run locally

```sh
npm install
npm run dev
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
