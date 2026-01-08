// modules/state/userAccess.js
// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA CENTRALIZADO DE CONTROL DE ACCESO
// ═══════════════════════════════════════════════════════════════════════════
//
// Este módulo es el ÚNICO punto de validación de acceso.
// Todos los routers deben usar checkAccess() antes de procesar mensajes.
//
// Reglas:
// - DM: Solo usuarios en users.json pueden interactuar
// - Grupos: Cualquier miembro puede interactuar (el bot ya está en el grupo)
// - Grupos: No se pueden crear tickets, solo responder/actualizar

const { getContext, isKnownUser } = require('./userDirectory');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function isGroup(chatId) {
  return typeof chatId === 'string' && chatId.endsWith('@g.us');
}

function isStatusBroadcast(chatId) {
  return chatId === 'status@broadcast';
}

// Normaliza phone para comparación
function normalizePhone(phoneId) {
  if (!phoneId) return null;
  return String(phoneId).replace(/@.*$/, '').replace(/\D/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: checkAccess
// ═══════════════════════════════════════════════════════════════════════════
// Retorna:
// {
//   allowed: boolean,
//   reason: string,
//   channel: 'dm' | 'group' | 'broadcast',
//   user: object | null,  // Info del usuario si está en users.json
//   effectiveRole: 'admin' | 'user' | 'guest',
//   canCreateTickets: boolean,
//   canUpdateTickets: boolean,
// }

function checkAccess(msg) {
  const chatId = msg?.from;
  
  if (!chatId) {
    return {
      allowed: false,
      reason: 'no_chat_id',
      channel: 'unknown',
      user: null,
      effectiveRole: 'guest',
      canCreateTickets: false,
      canUpdateTickets: false,
    };
  }
  
  // Status broadcast - siempre ignorar
  if (isStatusBroadcast(chatId)) {
    return {
      allowed: false,
      reason: 'status_broadcast',
      channel: 'broadcast',
      user: null,
      effectiveRole: 'guest',
      canCreateTickets: false,
      canUpdateTickets: false,
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // GRUPOS: Permitir interacción, pero no crear tickets
  // ═══════════════════════════════════════════════════════════════════════
  if (isGroup(chatId)) {
    // En grupos, msg.author es quien envió el mensaje
    const authorId = msg.author || null;
    const authorCtx = authorId ? getContext(authorId) : null;
    
    return {
      allowed: true,
      reason: 'group_member',
      channel: 'group',
      user: authorCtx?.isKnownUser ? authorCtx : null,
      effectiveRole: authorCtx?.isAdmin ? 'admin' : 'user',
      canCreateTickets: false,  // ❌ No se pueden crear tickets en grupos
      canUpdateTickets: true,   // ✅ Sí pueden actualizar/responder
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // DM: Solo usuarios en users.json
  // ═══════════════════════════════════════════════════════════════════════
  const userCtx = getContext(chatId);
  
  if (!userCtx.isKnownUser) {
    if (DEBUG) {
      const phone = normalizePhone(chatId);
      console.log('[ACCESS] denied: user not in users.json', { 
        phone: phone ? `...${phone.slice(-4)}` : 'unknown' 
      });
    }
    
    return {
      allowed: false,
      reason: 'not_authorized',
      channel: 'dm',
      user: null,
      effectiveRole: 'guest',
      canCreateTickets: false,
      canUpdateTickets: false,
    };
  }
  
  // Usuario autorizado
  return {
    allowed: true,
    reason: 'authorized_user',
    channel: 'dm',
    user: userCtx,
    effectiveRole: userCtx.isAdmin ? 'admin' : 'user',
    canCreateTickets: true,   // ✅ Pueden crear tickets
    canUpdateTickets: true,   // ✅ Pueden actualizar
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS ADICIONALES (para compatibilidad con código existente)
// ═══════════════════════════════════════════════════════════════════════════

function getEffectiveAccess(msg) {
  const access = checkAccess(msg);
  const chatId = msg?.from;
  const ctx = getContext(msg?.author || chatId);
  
  return {
    ...ctx,
    effectiveRole: access.effectiveRole,
    isAdmin: access.effectiveRole === 'admin',
    channel: access.channel,
    canCreateTickets: access.canCreateTickets,
    canUpdateTickets: access.canUpdateTickets,
  };
}

// Verifica si un chatId específico está autorizado (sin msg)
function isAuthorized(chatId) {
  if (!chatId) return false;
  if (isGroup(chatId)) return true; // Grupos siempre permitidos
  if (isStatusBroadcast(chatId)) return false;
  return isKnownUser(chatId);
}

// Mensaje de acceso denegado (para usar en routers)
function getAccessDeniedMessage() {
  return (
    '⚠️ Este servicio no está disponible para tu número.\n\n' +
    'Si crees que deberías tener acceso, contacta al administrador.'
  );
}

module.exports = {
  checkAccess,
  getEffectiveAccess,
  isAuthorized,
  isGroup,
  isStatusBroadcast,
  getAccessDeniedMessage,
};