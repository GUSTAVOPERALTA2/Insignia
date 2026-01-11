/**
 * niHandlers/modeAreaSelection.js
 * Handler para selección de área:
 * - choose_area_multi: elegir área destino de una lista
 */

const {
  DEBUG,
  norm,
  areaLabel,
  normalizeAreaCode,
  formatPreviewMessage,
  AREA_LABELS,
} = require('./shared');

/**
 * Handler para modo choose_area_multi
 */
async function handleChooseAreaMulti(ctx) {
  const { s, msg, text, replySafe, setMode, setDraftField, addArea, resetSession } = ctx;

  const t = norm(text);
  const pendingAreas = s._multiAreaPending || [];
  const areaKeys = Object.keys(AREA_LABELS);

  if (DEBUG) console.log('[CHOOSE_AREA] handling', { response: text, pendingAreas: pendingAreas.length });

  // Cancelar
  if (/^cancelar?/i.test(t) || /^volver/i.test(t)) {
    // Si hay draft con contenido, volver a confirm
    if (s.draft?.descripcion) {
      setMode(s, 'confirm');
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, '↩️ Cancelado.\n\n' + preview);
    } else {
      resetSession(s.chatId);
      await replySafe(msg, '❌ Cancelado. Si necesitas reportar algo, solo escríbeme.');
    }
    return true;
  }

  // Selección por número
  const numMatch = t.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;

    // Verificar si hay áreas pendientes (de detección múltiple)
    if (pendingAreas.length > 0 && idx >= 0 && idx < pendingAreas.length) {
      const selectedArea = pendingAreas[idx];
      const areaCode = selectedArea.code || selectedArea;

      setDraftField(s, 'area_destino', areaCode);
      addArea(s, areaCode);

      // Limpiar pendientes
      s._multiAreaPending = null;
      s._multiAreaOriginalText = null;

      setMode(s, 'confirm');
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, `✅ Área seleccionada: *${areaLabel(areaCode)}*\n\n` + preview);
      return true;
    }

    // Selección por índice del menú estándar
    if (idx >= 0 && idx < areaKeys.length) {
      const selectedArea = areaKeys[idx];

      setDraftField(s, 'area_destino', selectedArea);
      addArea(s, selectedArea);

      setMode(s, 'confirm');
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, `✅ Área: *${areaLabel(selectedArea)}*\n\n` + preview);
      return true;
    }
  }

  // Intentar normalizar área por nombre/alias
  const areaCode = normalizeAreaCode(text);
  if (areaCode) {
    setDraftField(s, 'area_destino', areaCode);
    addArea(s, areaCode);

    // Limpiar pendientes si los hay
    s._multiAreaPending = null;
    s._multiAreaOriginalText = null;

    setMode(s, 'confirm');
    const preview = formatPreviewMessage(s.draft);
    await replySafe(msg, `✅ Área: *${areaLabel(areaCode)}*\n\n` + preview);
    return true;
  }

  // Verificar si escribió el nombre del área directamente
  if (pendingAreas.length > 0) {
    const directMatch = pendingAreas.find(a => {
      const code = a.code || a;
      return norm(code) === t || norm(areaLabel(code)) === t;
    });

    if (directMatch) {
      const areaCode = directMatch.code || directMatch;
      setDraftField(s, 'area_destino', areaCode);
      addArea(s, areaCode);

      s._multiAreaPending = null;
      s._multiAreaOriginalText = null;

      setMode(s, 'confirm');
      const preview = formatPreviewMessage(s.draft);
      await replySafe(msg, `✅ Área seleccionada: *${areaLabel(areaCode)}*\n\n` + preview);
      return true;
    }
  }

  // No reconocido - mostrar opciones
  if (pendingAreas.length > 0) {
    // Mostrar opciones de detección múltiple
    const areaOptions = pendingAreas.map((a, i) => {
      const code = a.code || a;
      const hint = a.hint || '';
      return `*${i + 1}.* ${areaLabel(code)}${hint ? ` — _${hint}_` : ''}`;
    }).join('\n');

    await replySafe(msg,
      `🤔 No entendí. Responde con el *número* de la opción:\n\n` +
      `${areaOptions}\n\n` +
      `O escribe *cancelar* para descartar.`
    );
  } else {
    // Mostrar menú estándar
    let options = '🏷️ No reconocí esa área. Elige una:\n\n';
    areaKeys.forEach((key, i) => {
      options += `*${i + 1}.* ${AREA_LABELS[key]} (${key})\n`;
    });
    options += '\n• *cancelar* — volver al ticket';

    await replySafe(msg, options);
  }

  return true;
}

/**
 * Handler principal para selección de área
 */
async function handleAreaSelection(ctx) {
  const { s, text } = ctx;

  if (!text) return false;

  if (s.mode === 'choose_area_multi') {
    return handleChooseAreaMulti(ctx);
  }

  return false;
}

module.exports = { handleAreaSelection };
