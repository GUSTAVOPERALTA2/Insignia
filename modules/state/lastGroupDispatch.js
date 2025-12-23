// modules/state/lastGroupDispatch.js
// Cache en memoria para:
// - Historial de últimos tickets despachados por grupo (varios por grupo, con pruning)
// - Mapeo incidente -> requesterChat (+ grupos y folio) para notificar al emisor

// Estructuras:
// byGroup: gid -> [{ incidentId, ts, folio }]
// byIncident: incidentId -> { requesterChat, groups: Set<string>, folio }
const byGroup = new Map();
const byIncident = new Map();

// Prunea entradas antiguas (> maxAgeMs) del array de un grupo
function pruneGroupHistory(gid, maxAgeMs) {
  const arr = byGroup.get(gid);
  if (!arr || !arr.length) return;
  const limit = Date.now() - maxAgeMs;
  // Mantener orden cronológico y eliminar lo viejo del inicio
  while (arr.length && arr[0].ts < limit) arr.shift();
  if (arr.length) byGroup.set(gid, arr);
  else byGroup.delete(gid);
}

/**
 * Registra un despacho de incidencia hacia uno o varios grupos y/o guarda el requester.
 * - incidentId: id de la incidencia
 * - groupIds: array de groupIds destino (puede ser [])
 * - opts: { folio?: string|null, requesterChat?: string|null }
 */
function recordGroupDispatch(incidentId, groupIds = [], { folio = null, requesterChat = null } = {}) {
  const ts = Date.now();

  // Asegura registro por incidente
  let rec = byIncident.get(incidentId);
  if (!rec) {
    rec = { requesterChat: null, groups: new Set(), folio: null };
    byIncident.set(incidentId, rec);
  }
  if (requesterChat) rec.requesterChat = requesterChat;
  if (folio) rec.folio = folio;

  // Registra por grupo (historial)
  for (const gid of groupIds) {
    if (!gid) continue;
    rec.groups.add(gid);

    const arr = byGroup.get(gid) || [];
    arr.push({ incidentId, ts, folio: folio || rec.folio || null });

    // Prune de entradas mayores a 24h para no crecer sin límite
    byGroup.set(gid, arr);
    pruneGroupHistory(gid, 24 * 60 * 60 * 1000);
  }

  return true;
}

/**
 * Devuelve el último ticket despachado a un grupo dentro de windowMin minutos.
 * @returns { incidentId?: string, ts?: number, folio?: string|null } | null
 */
function getRecentForGroup(groupId, windowMin = 30) {
  const arr = byGroup.get(groupId) || [];
  if (!arr.length) return null;

  const limit = Date.now() - (windowMin * 60 * 1000);
  // Busca desde el final (más reciente)
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item.ts >= limit) return item;
    // Si ya encontramos uno más viejo que el límite y estamos yendo hacia atrás,
    // podemos cortar porque el resto será aún más viejo (el array está en orden cronológico).
    if (item.ts < limit) break;
  }
  return null;
}

/**
 * Devuelve el chat del solicitante (emisor original) para un incidente, si se registró.
 */
function getRequesterForIncident(incidentId) {
  const rec = byIncident.get(incidentId);
  return rec?.requesterChat || null;
}

module.exports = {
  recordGroupDispatch,
  getRecentForGroup,
  getRequesterForIncident,
};
