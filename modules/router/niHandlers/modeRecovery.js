/**
 * niHandlers/modeRecovery.js
 * Handlers para modos de recuperación:
 * - confused_recovery: recuperación cuando el bot está confundido
 * - choose_incident_version: elegir entre versiones de incidente
 */

const {
  DEBUG,
  norm,
  isYes,
  isNo,
  formatPreviewMessage,
} = require('./shared');

/**
 * Handler para modo confused_recovery
 */
async function handleConfusedRecovery(ctx) {
  const { s, msg, text, replySafe, setMode, resetSession } = ctx;

  const t = norm(text);

  if (DEBUG) console.log('[CONFUSED] handling', { response: text });

  // Continuar con lo que hay
  if (/^continuar?/i.test(t) || /^seguir/i.test(t) || isYes(text)) {
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '👍 Continuamos:\n\n' + preview);
    return true;
  }

  // Empezar de nuevo
  if (/^reiniciar?/i.test(t) || /^nuevo/i.test(t) || /^empezar/i.test(t)) {
    resetSession(s.chatId);
    await replySafe(msg,
      '🔄 Empezamos de nuevo.\n\n' +
      'Cuéntame qué problema quieres reportar.'
    );
    return true;
  }

  // Cancelar todo
  if (/^cancelar?/i.test(t) || isNo(text)) {
    resetSession(s.chatId);
    await replySafe(msg, '❌ Ticket cancelado.');
    return true;
  }

  // Mostrar opciones
  await replySafe(msg,
    '🤔 Parece que hubo confusión. ¿Qué hacemos?\n\n' +
    '• *continuar* — seguir con el ticket actual\n' +
    '• *reiniciar* — empezar de nuevo\n' +
    '• *cancelar* — descartar todo'
  );
  return true;
}

/**
 * Handler para modo choose_incident_version
 */
async function handleChooseIncidentVersion(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, refreshIncidentDescription } = ctx;

  const versions = s._incidentVersions || [];
  const t = norm(text);

  if (DEBUG) console.log('[CHOOSE_VERSION] handling', { response: text, versions: versions.length });

  // Cancelar
  if (/^cancelar?/i.test(t)) {
    s._incidentVersions = [];
    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, '↩️ Sin cambios:\n\n' + preview);
    return true;
  }

  // Selección por número
  const numMatch = t.match(/^(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < versions.length) {
      const selected = versions[idx];

      // Aplicar versión seleccionada
      if (selected.descripcion) {
        s.draft.descripcion = selected.descripcion;
        s.draft.descripcion_original = selected.descripcion;
      }
      if (selected.lugar) {
        s.draft.lugar = selected.lugar;
      }
      if (selected.area_destino) {
        setDraftField(s, 'area_destino', selected.area_destino);
      }

      s._incidentVersions = [];

      if (refreshIncidentDescription) {
        await refreshIncidentDescription(s, s.draft.descripcion);
      }

      setMode(s, 'confirm');
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '✅ Versión seleccionada:\n\n' + preview);
      return true;
    }
  }

  // Mostrar versiones
  let options = '📋 Elige una versión:\n\n';
  versions.forEach((v, i) => {
    const desc = (v.descripcion || '').substring(0, 60);
    options += `*${i + 1}.* ${desc}${desc.length >= 60 ? '...' : ''}\n`;
    if (v.lugar) options += `   📍 ${v.lugar}\n`;
    options += '\n';
  });
  options += '• *cancelar* — mantener actual';

  await replySafe(msg, options);
  return true;
}

/**
 * Handler principal para modos de recuperación
 */
async function handleRecovery(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  switch (s.mode) {
    case 'confused_recovery':
      return handleConfusedRecovery(ctx);
    case 'choose_incident_version':
      return handleChooseIncidentVersion(ctx);
    default:
      return false;
  }
}

module.exports = { handleRecovery };
