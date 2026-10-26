// A company's software licence: active, read-only (expired, within the grace days), or blocked.

import { HttpError, todayIst } from './http.js';

export const PROVIDER = 'Rugged Customs';

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// co: a companies row with status, valid_till and grace_days.
export function licenceOf(co, today = todayIst()) {
  if (co.status === 'Suspended') return { state: 'suspended' };
  if (co.status === 'Closed') return { state: 'closed' };
  if (!co.valid_till || co.valid_till >= today) return { state: 'active', valid_till: co.valid_till || null };
  const until = addDays(co.valid_till, co.grace_days ?? 15);
  if (today <= until) return { state: 'read-only', valid_till: co.valid_till, read_only_until: until };
  return { state: 'expired', valid_till: co.valid_till };
}

export const blocked = (l) => l.state === 'suspended' || l.state === 'closed' || l.state === 'expired';

const dmy = (d) => d.split('-').reverse().join('-');

export function licenceMessage(l) {
  if (l.state === 'suspended') return `The software licence of this company is suspended. Please contact ${PROVIDER}.`;
  if (l.state === 'closed') return `This company's account is closed. Please contact ${PROVIDER}.`;
  if (l.state === 'expired') return `The software licence expired on ${dmy(l.valid_till)}. Please contact ${PROVIDER} to renew it.`;
  if (l.state === 'read-only') return `The software licence expired on ${dmy(l.valid_till)}. You can look at your data until ${dmy(l.read_only_until)}, but not change it. Please contact ${PROVIDER} to renew it.`;
  return '';
}

export function assertNotBlocked(l) {
  if (blocked(l)) throw new HttpError(403, licenceMessage(l));
}
