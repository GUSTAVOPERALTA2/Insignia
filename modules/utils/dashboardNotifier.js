/**
 * modules/utils/dashboardNotifier.js
 * 
 * Helper para notificar cambios al dashboard en tiempo real.
 * Usa HTTP POST al webhook del dashboard.
 * 
 * Uso:
 *   const { notifyDashboard } = require('./utils/dashboardNotifier');
 *   
 *   // Cuando se crea una incidencia
 *   notifyDashboard({ type: 'new_incident', incidentId: '...', folio: 'IT-001' });
 *   
 *   // Cuando se actualiza estado
 *   notifyDashboard({ type: 'status_change', incidentId: '...', status: 'done' });
 *   
 *   // Cuando se agrega comentario
 *   notifyDashboard({ type: 'incident_update', incidentId: '...' });
 */

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// Configuración
const DASHBOARD_WEBHOOK_URL = process.env.VICEBOT_DASHBOARD_WEBHOOK_URL || 'http://localhost:3031/api/webhook/notify';
const DASHBOARD_WEBHOOK_TOKEN = process.env.VICEBOT_DASHBOARD_WEBHOOK_TOKEN || null;

/**
 * Notifica al dashboard sobre cambios en incidencias
 * No bloquea ni falla si el dashboard no está disponible
 * 
 * @param {Object} payload - Datos a enviar
 * @param {string} payload.type - Tipo de evento: 'new_incident', 'status_change', 'incident_update'
 * @param {string} [payload.incidentId] - ID de la incidencia
 * @param {string} [payload.folio] - Folio de la incidencia
 * @param {string} [payload.status] - Nuevo estado (si aplica)
 */
async function notifyDashboard(payload) {
  if (!payload || !payload.type) {
    if (DEBUG) console.warn('[DASH-NOTIFY] Missing payload.type');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (DASHBOARD_WEBHOOK_TOKEN) {
      headers['Authorization'] = `Bearer ${DASHBOARD_WEBHOOK_TOKEN}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const res = await fetch(DASHBOARD_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString()
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (DEBUG && res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log(`[DASH-NOTIFY] OK (${data.clients || 0} clients):`, payload.type);
    }
  } catch (e) {
    // Silencioso - el dashboard puede no estar corriendo
    if (DEBUG) {
      const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown');
      console.log('[DASH-NOTIFY] Skip:', msg);
    }
  }
}

/**
 * Notifica creación de nueva incidencia
 */
function notifyNewIncident(incidentId, folio, area) {
  return notifyDashboard({
    type: 'new_incident',
    incidentId,
    folio,
    area
  });
}

/**
 * Notifica cambio de estado
 */
function notifyStatusChange(incidentId, folio, fromStatus, toStatus) {
  return notifyDashboard({
    type: 'status_change',
    incidentId,
    folio,
    from: fromStatus,
    status: toStatus
  });
}

/**
 * Notifica actualización general (comentario, adjunto, etc.)
 */
function notifyIncidentUpdate(incidentId, folio, updateType) {
  return notifyDashboard({
    type: 'incident_update',
    incidentId,
    folio,
    updateType
  });
}

module.exports = {
  notifyDashboard,
  notifyNewIncident,
  notifyStatusChange,
  notifyIncidentUpdate
};
