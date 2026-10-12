// Chit Master Pro API (Cloudflare Worker + D1).
// Starting point only: a health check and read-only lists to prove the database works.
// Logins, roles and writes come next; nothing here is protected yet, so use test data only.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const routes = {
  'GET /api/health': async (env) => {
    const { results } = await env.DB.prepare('SELECT count(*) AS companies FROM companies').all();
    return json({ ok: true, database: 'connected', companies: results[0].companies });
  },

  // Groups with the installment worked out (amounts in paise).
  'GET /api/groups': async (env) => {
    const { results } = await env.DB.prepare(
      `SELECT g.id, g.name, g.chit_amount, g.installments,
              COALESCE(g.installment_amount, g.chit_amount / g.installments) AS installment,
              g.commission_bp, g.status,
              (SELECT count(*) FROM enrollments e WHERE e.group_id = g.id AND e.status = 'Active') AS tickets_filled,
              (SELECT count(*) FROM auctions a WHERE a.group_id = g.id AND a.status = 'Active') AS auctions_held
         FROM chit_groups g
        ORDER BY g.name`
    ).all();
    return json(results);
  },
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const handler = routes[`${request.method} ${pathname}`];
    if (!handler) return json({ error: 'Not found' }, 404);
    try {
      return await handler(env);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  },
};
