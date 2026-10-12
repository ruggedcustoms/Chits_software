// Request and response helpers.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const bad = (message, details) => new HttpError(400, message, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);
export const forbidden = (message = 'You do not have permission to do this.') => new HttpError(403, message);
export const conflict = (message) => new HttpError(409, message);

export async function readBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw bad('Send the details as a JSON object.');
  }
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// India Standard Time date, since the business day runs on IST.
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// ---- field checks: each returns the cleaned value or throws a 400 ----

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function str(body, key, { required = false, max = 200, label = key } = {}) {
  const v = body[key];
  if (v == null || String(v).trim() === '') {
    if (required) throw bad(`Enter ${label}.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw bad(`${label} is too long (most ${max} characters).`);
  return s;
}

// Money in paise (whole number). Rs 21,250 is sent as 2125000.
export function paise(body, key, { required = false, min = 0, label = key } = {}) {
  const v = body[key];
  if (v == null || v === '') {
    if (required) throw bad(`Enter ${label}.`);
    return null;
  }
  if (!Number.isSafeInteger(v) || v < min) throw bad(`${label} must be a whole number of paise, at least ${min}.`);
  return v;
}

export function int(body, key, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER, label = key } = {}) {
  const v = body[key];
  if (v == null || v === '') {
    if (required) throw bad(`Enter ${label}.`);
    return null;
  }
  if (!Number.isSafeInteger(v) || v < min || v > max) throw bad(`${label} must be a whole number from ${min} to ${max}.`);
  return v;
}

export function date(body, key, { required = false, label = key } = {}) {
  const v = body[key];
  if (v == null || v === '') {
    if (required) throw bad(`Enter ${label}.`);
    return null;
  }
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${label} must be a date like 2026-10-12.`);
  return v;
}

export function oneOf(body, key, options, { required = false, fallback = null, label = key } = {}) {
  const v = body[key];
  if (v == null || v === '') {
    if (required) throw bad(`Choose ${label}.`);
    return fallback;
  }
  if (!options.includes(v)) throw bad(`${label} must be one of: ${options.join(', ')}.`);
  return v;
}

export const bool = (body, key, fallback = false) => (body[key] == null ? fallback : body[key] ? 1 : 0);

// An id chosen by the client, so a screen can keep pointing at the record it just saved.
export function clientId(body) {
  const v = body.id;
  if (v == null || v === '') return newId();
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(v)) throw bad('id must be 6 to 64 letters, digits, _ or -.');
  return v;
}

// Extra details kept as JSON (see migrations/0003_extra_fields.sql).
export function extra(body, max = 200000) {
  const v = body.extra;
  if (v == null) return '{}';
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('extra must be an object.');
  const s = JSON.stringify(v);
  if (s.length > max) throw bad('The extra details are too large.');
  return s;
}
