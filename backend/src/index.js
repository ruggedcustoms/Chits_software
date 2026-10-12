// Chit Master Pro API (Cloudflare Worker + D1).
// Every route except health, setup and login needs "Authorization: Bearer <token>" from /api/auth/login.
// Money is in paise and percentages in basis points, both as whole numbers.

import { HttpError, json } from './lib/http.js';
import { authenticate } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { masterRoutes } from './routes/masters.js';
import { moneyRoutes } from './routes/money.js';
import { reportRoutes } from './routes/reports.js';
import { syncRoutes } from './routes/sync.js';

async function health({ env }) {
  const row = await env.DB.prepare('SELECT count(*) AS companies FROM companies').first();
  return json({ ok: true, database: 'connected', companies: row.companies });
}

// '/api/groups/:id' becomes a pattern that captures id.
const compile = ([method, path, handler, opts = {}]) => {
  const names = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
  return { method, re, names, handler, public: !!opts.public };
};

const routes = [['GET', '/api/health', health, { public: true }], ...authRoutes, ...masterRoutes, ...moneyRoutes, ...reportRoutes, ...syncRoutes].map(compile);

function dbError(err) {
  const m = String(err && err.message);
  if (m.includes('UNIQUE constraint failed')) return new HttpError(409, 'This would create a duplicate. ' + m.split('UNIQUE constraint failed:')[1]?.split(':')[0]?.trim());
  if (m.includes('FOREIGN KEY constraint failed')) return new HttpError(400, 'A linked record does not exist.');
  if (m.includes('CHECK constraint failed')) return new HttpError(400, 'A value is not allowed: ' + m.split('CHECK constraint failed:')[1]?.split(':')[0]?.trim());
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let pathMatched = false;
    for (const r of routes) {
      const m = url.pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        const ctx = r.public ? null : await authenticate(env.DB, request);
        return await r.handler({ request, env, ctx, params, query: url.searchParams });
      } catch (err) {
        const known = err instanceof HttpError ? err : dbError(err);
        if (known) return json({ error: known.message, details: known.details }, known.status);
        console.error(err);
        return json({ error: 'Something went wrong on the server. Nothing was saved.' }, 500);
      }
    }
    return pathMatched ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
  },
};
