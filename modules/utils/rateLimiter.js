// Rate limit simple en memoria por clave
const buckets = new Map();

function now(){ return Date.now(); }

function allow(key, { windowMs = 60_000, max = 1 } = {}) {
  const t = now();
  const b = buckets.get(key) || [];
  const pruned = b.filter(ts => t - ts < windowMs);
  if (pruned.length >= max) { buckets.set(key, pruned); return false; }
  pruned.push(t);
  buckets.set(key, pruned);
  return true;
}

module.exports = { allow };
