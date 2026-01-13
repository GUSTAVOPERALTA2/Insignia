/**
 * niHandlers/index.js
 * Orquestador de modos para routeIncomingNI
 */

const { handleConfirm } = require('./modeConfirm');
const { handleEdit } = require('./modeEdit');
const { handleContextSwitch } = require('./modeContextSwitch');
const { handlePlaceSelection } = require('./modePlaceSelection');
const { handleAreaSelection } = require('./modeAreaSelection');
const { handleMultipleTickets } = require('./modeMultipleTickets');
const { handleRecovery } = require('./modeRecovery');
const { handleNeutral } = require('./modeNeutral');

// ✅ NUEVO: handler dedicado para elegir lugar desde candidatos
const { handleChoosePlaceFromCandidates } = require('./modeChoosePlaceFromCandidates');

// Mapa de modos a handlers
const modeHandlers = {
  // Confirmación
  'confirm': handleConfirm,
  'preview': handleConfirm,
  'confirm_batch': handleConfirm,

  // Edición
  'edit': handleEdit,
  'edit_menu': handleEdit,
  'edit_description': handleEdit,
  'edit_menu_place': handleEdit,
  'edit_batch_ticket': handleEdit,
  'edit_multiple_ticket': handleEdit,

  // Cambio de contexto
  'context_switch': handleContextSwitch,
  'different_problem': handleContextSwitch,
  'description_or_new': handleContextSwitch,
  'followup_decision': handleContextSwitch,
  'followup_place_decision': handleContextSwitch,

  // Selección de lugar
  'ask_place': handlePlaceSelection,
  'ask_place_conflict': handlePlaceSelection,

  // ✅ AQUÍ: antes estaba handlePlaceSelection, ahora es tu handler dedicado
  'choose_place_from_candidates': handleChoosePlaceFromCandidates,

  // Esto sigue siendo parte del flujo “place selection”
  'ask_area_multiple': handlePlaceSelection,
  'choose_area_single': handlePlaceSelection,

  // Selección de área
  'choose_area_multi': handleAreaSelection,

  // Múltiples tickets
  'multiple_tickets': handleMultipleTickets,

  // Recuperación
  'confused_recovery': handleRecovery,
  'choose_incident_version': handleRecovery,

  // Neutral
  'neutral': handleNeutral,
};

const SUPPORTED_MODES = Object.keys(modeHandlers);

function getHandler(mode) {
  return modeHandlers[mode] || modeHandlers['neutral'];
}

module.exports = {
  getHandler,
  SUPPORTED_MODES,
  modeHandlers,
};
