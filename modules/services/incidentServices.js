// modules/services/incidentsService.js
// Puerta única para cambios de estado + efectos colaterales (notificaciones)

const db = require('../db/incidenceDB');
const { notifyOnCancel } = require('../../dashboard/cancelNotify');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

/**
 * Cancela una incidencia y, si el cambio ocurrió, dispara notificaciones
 * al grupo y al emisor.
 * meta: { by?, note?, source? }
 */
async function cancelIncidentAndNotify(incidentId, meta = {}) {
  // 1) Cambiar estado (genera evento status_change en DB)
  const res = db.updateIncidentStatus(incidentId, 'canceled');
  if (!res) throw new Error('No se pudo actualizar el estado a canceled');

  // 2) Evitar duplicados: si ya estaba cancelada, no notificamos
  if (String(res.from || '').toLowerCase() === 'canceled') {
    if (DEBUG) console.log('[Service] cancelIncidentAndNotify: ya estaba canceled, no notifico.', { incidentId });
    return { ok: true, updated: false, state: res };
  }

  // 3) Notificar (grupo + emisor)
  try {
    await notifyOnCancel({ incidentId, meta });
  } catch (e) {
    console.warn('[Service] notifyOnCancel error', e?.message || e);
  }

  return { ok: true, updated: true, state: res };
}

/**
 * Wrapper genérico por si quieres enrutar TODOS los cambios de estado aquí.
 * Hoy sólo aplica notificaciones especiales para 'canceled'.
 */
async function setStatusWithSideEffects(incidentId, newStatus, meta = {}) {
  if (String(newStatus).toLowerCase() === 'canceled') {
    return cancelIncidentAndNotify(incidentId, meta);
  }
  const res = db.updateIncidentStatus(incidentId, newStatus);
  if (!res) throw new Error('No se pudo actualizar el estado');
  return { ok: true, updated: true, state: res };
}

module.exports = {
  cancelIncidentAndNotify,
  setStatusWithSideEffects,
};
