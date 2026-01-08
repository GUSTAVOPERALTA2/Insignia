// modules/state/accessRequest.js
// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA DE SOLICITUD DE ACCESO
// ═══════════════════════════════════════════════════════════════════════════
//
// Flujo:
// 1. Usuario no autorizado envía mensaje → Bot responde con invitación a solicitar
// 2. Usuario responde con sus datos → Bot valida y envía a admin
// 3. Admin aprueba/rechaza → Bot notifica al solicitante
// 4. Si aprobado → Se agrega a users.json

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════════════

const USERS_PATH = process.env.VICEBOT_USERS_PATH || 
                   path.join(process.cwd(), 'data', 'users.json');

// Admin por defecto para recibir solicitudes
const DEFAULT_ADMIN_ID = '5217751801318@c.us';

// Departamentos válidos y su mapeo a team
const VALID_DEPARTMENTS = {
  'it': { team: 'it', aliases: ['it', 'sistemas', 'tecnología', 'tecnologia', 'informatica', 'informática'] },
  'seguridad': { team: 'seg', aliases: ['seguridad', 'vigilancia', 'security'] },
  'hskp': { team: 'ama', aliases: ['hskp', 'housekeeping', 'ama de llaves', 'limpieza', 'camaristas'] },
  'room service': { team: 'rs', aliases: ['room service', 'roomservice', 'rs', 'servicio a cuartos', 'servicio a habitaciones'] },
  'mantenimiento': { team: 'man', aliases: ['mantenimiento', 'maintenance', 'mtto', 'man'] },
};

// Cache de solicitudes pendientes { odId: { nombre, cargo, team, requestedAt, messageId } }
const pendingRequests = new Map();

// Cache de solicitudes enviadas a admin { odId: { solicitanteId, nombre, cargo, team, sentAt } }
const pendingApprovals = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// SESIONES DE SOLICITUD EN PROGRESO
// Guarda el contexto mientras el usuario va proporcionando datos
// ═══════════════════════════════════════════════════════════════════════════
const accessSessions = new Map(); // chatId -> { nombre, cargo, departamento, lastUpdate }
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutos de inactividad

function getAccessSession(chatId) {
  const session = accessSessions.get(chatId);
  if (!session) return null;
  
  // Verificar si expiró
  if (Date.now() - session.lastUpdate > SESSION_TTL_MS) {
    accessSessions.delete(chatId);
    return null;
  }
  
  return session;
}

function updateAccessSession(chatId, data) {
  const existing = getAccessSession(chatId) || {
    nombre: null,
    cargo: null,
    departamento: null,
    team: null,
  };
  
  const updated = {
    ...existing,
    ...data,
    lastUpdate: Date.now(),
  };
  
  accessSessions.set(chatId, updated);
  return updated;
}

function clearAccessSession(chatId) {
  accessSessions.delete(chatId);
}

function isSessionComplete(session) {
  return session && session.nombre && session.cargo && session.departamento;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function detectTitulo(nombre) {
  if (!nombre) return 'Sr.';
  
  const normalized = normalizeText(nombre);
  
  // Nombres femeninos comunes en español
  const femeninoPatterns = [
    /^(maria|ana|luz|carmen|rosa|laura|patricia|elizabeth|gabriela|andrea|diana|monica|veronica|claudia|adriana|sandra|lucia|fernanda|daniela|alejandra|margarita|beatriz|teresa|ruth|mayra|yadira|maribel|lourdes|tania|omaly|adria)/i,
    /(a|ia|na|da|la|ra|sa|za|ta|ya)$/i, // Terminaciones típicamente femeninas
  ];
  
  // Excepciones masculinas que terminan en 'a'
  const masculinoExceptions = ['joshua', 'nikita', 'josema', 'garcia', 'peña'];
  
  const firstName = normalized.split(/\s+/)[0];
  
  if (masculinoExceptions.includes(firstName)) {
    return 'Sr.';
  }
  
  for (const pattern of femeninoPatterns) {
    if (pattern.test(firstName)) {
      return 'Srta.';
    }
  }
  
  return 'Sr.';
}

function normalizeDepartment(input) {
  const normalized = normalizeText(input);
  
  for (const [key, config] of Object.entries(VALID_DEPARTMENTS)) {
    for (const alias of config.aliases) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        return { department: key, team: config.team };
      }
    }
  }
  
  return null;
}

function getAdminIds() {
  try {
    let raw = fs.readFileSync(USERS_PATH, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');
    const users = JSON.parse(raw);
    
    const admins = [];
    for (const [waId, user] of Object.entries(users)) {
      if (user.rol === 'admin') {
        admins.push(waId);
      }
    }
    
    // Si no hay admins, usar el default
    if (admins.length === 0) {
      admins.push(DEFAULT_ADMIN_ID);
    }
    
    return admins;
  } catch (e) {
    if (DEBUG) console.warn('[ACCESS-REQ] getAdminIds err:', e?.message);
    return [DEFAULT_ADMIN_ID];
  }
}

function addUserToFile(waId, userData) {
  try {
    let raw = fs.readFileSync(USERS_PATH, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');
    const users = JSON.parse(raw);
    
    // Agregar nuevo usuario
    users[waId] = userData;
    
    // Escribir de vuelta
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), 'utf8');
    
    if (DEBUG) console.log('[ACCESS-REQ] user added to file:', { waId, nombre: userData.nombre });
    
    return true;
  } catch (e) {
    console.error('[ACCESS-REQ] addUserToFile err:', e?.message || e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDACIÓN DE DATOS CON IA
// ═══════════════════════════════════════════════════════════════════════════

async function parseAccessRequestWithAI(text, existingSession = null) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Construir contexto si existe sesión previa
    let contextInfo = '';
    if (existingSession) {
      const existing = [];
      if (existingSession.nombre) existing.push(`nombre: "${existingSession.nombre}"`);
      if (existingSession.cargo) existing.push(`cargo: "${existingSession.cargo}"`);
      if (existingSession.departamento) existing.push(`departamento: "${existingSession.departamento}"`);
      
      if (existing.length > 0) {
        contextInfo = `\n\nDATOS YA PROPORCIONADOS por el usuario en mensajes anteriores:\n${existing.join('\n')}\n\nSolo extrae datos NUEVOS del mensaje actual. Si el mensaje actual contiene un dato que ya existe, el nuevo reemplaza al anterior.`;
      }
    }
    
    const systemPrompt = `Eres un asistente que extrae datos de solicitudes de acceso.
El usuario proporciona: nombre completo, cargo y/o departamento.
Puede enviar todo junto o por separado en diferentes mensajes.

Departamentos válidos ÚNICAMENTE:
- IT (sistemas, tecnología, informática)
- Seguridad (vigilancia)
- HSKP (housekeeping, ama de llaves, limpieza, camaristas)
- Room Service (servicio a cuartos, RS)
- Mantenimiento (mtto)
${contextInfo}

IMPORTANTE: 
- Si el mensaje solo dice un nombre (ej: "Juan Pérez García"), extrae solo el nombre
- Si dice un cargo (ej: "Supervisor", "Auxiliar de sistemas"), extrae solo el cargo
- Si dice un departamento (ej: "IT", "Mantenimiento"), extrae solo el departamento
- El mensaje puede contener uno, dos o los tres datos

Responde SOLO con JSON válido, sin markdown:
{
  "nombre": "string o null si no aparece en este mensaje",
  "cargo": "string o null si no aparece en este mensaje",
  "departamento": "string normalizado (IT/Seguridad/HSKP/Room Service/Mantenimiento) o null si no es válido o no aparece"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: 200,
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    
    // Limpiar posible markdown
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    
    return JSON.parse(cleaned);
  } catch (e) {
    if (DEBUG) console.warn('[ACCESS-REQ] parseAccessRequestWithAI err:', e?.message);
    
    // Fallback: intentar detectar manualmente
    return parseAccessRequestManual(text);
  }
}

/**
 * Fallback manual si la IA falla
 */
function parseAccessRequestManual(text) {
  const result = { nombre: null, cargo: null, departamento: null };
  const t = text.toLowerCase().trim();
  
  // Detectar departamento
  for (const [key, config] of Object.entries(VALID_DEPARTMENTS)) {
    for (const alias of config.aliases) {
      if (t.includes(alias)) {
        result.departamento = key.charAt(0).toUpperCase() + key.slice(1);
        if (key === 'it') result.departamento = 'IT';
        if (key === 'hskp') result.departamento = 'HSKP';
        if (key === 'room service') result.departamento = 'Room Service';
        break;
      }
    }
    if (result.departamento) break;
  }
  
  // Detectar cargo común
  const cargoPatterns = [
    /\b(supervisor|gerente|manager|auxiliar|asistente|jefe|director|coordinador|técnico|recepcionista)\b/i,
    /\b(aux\.?\s*(de\s+)?[\w]+)/i,
  ];
  
  for (const pattern of cargoPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.cargo = match[0].trim();
      break;
    }
  }
  
  // Si no detectamos cargo ni departamento, asumir que es nombre
  if (!result.cargo && !result.departamento && text.length > 3) {
    // Verificar que parece un nombre (al menos 2 palabras con mayúsculas)
    const words = text.split(/\s+/);
    if (words.length >= 2 || /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/.test(text)) {
      result.nombre = text;
    }
  }
  
  return result;
}

async function generateDeniedMessage() {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const systemPrompt = `Eres el bot de un hotel de lujo. Genera un mensaje para alguien que intenta usar el sistema pero no tiene acceso.

FORMATO EXACTO (respeta los saltos de línea):
[Una oración corta y amigable con toque de humor - máximo 15 palabras]

Para solicitar acceso, envíame:
• *Nombre completo*
• *Cargo*
• *Departamento* (IT, Seguridad, HSKP, Room Service o Mantenimiento)

[Una oración de despedida amigable - máximo 10 palabras]

REGLAS:
- Primera línea: humor ligero, sin ser irrespetuoso
- Lista: exactamente como está, no cambies el formato
- Despedida: breve y positiva
- NO uses emojis en exceso (máximo 1-2 en todo el mensaje)
- Responde SOLO con el mensaje, sin comillas ni explicaciones`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Genera el mensaje' }
      ],
      temperature: 0.8,
      max_tokens: 200,
    });
    
    return response.choices[0]?.message?.content?.trim() || getDefaultDeniedMessage();
  } catch (e) {
    if (DEBUG) console.warn('[ACCESS-REQ] generateDeniedMessage err:', e?.message);
    return getDefaultDeniedMessage();
  }
}

function getDefaultDeniedMessage() {
  return (
    '🚪 ¡Hola! Parece que aún no tienes llave para entrar al sistema.\n\n' +
    'Para solicitar acceso, envíame:\n' +
    '• *Nombre completo*\n' +
    '• *Cargo*\n' +
    '• *Departamento* (IT, Seguridad, HSKP, Room Service o Mantenimiento)\n\n' +
    '¡Quedo al pendiente de tu solicitud!'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLERS PRINCIPALES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Genera mensaje de acceso denegado con IA
 * @returns {Promise<string>}
 */
async function getAccessDeniedMessageAsync() {
  return await generateDeniedMessage();
}

/**
 * Procesa respuesta de usuario no autorizado solicitando acceso
 * Acumula datos en sesión hasta tener nombre + cargo + departamento
 * @param {object} client - WhatsApp client
 * @param {object} msg - Mensaje del usuario
 * @returns {Promise<{handled: boolean, needsMoreInfo?: boolean, sentToAdmin?: boolean}>}
 */
async function handleAccessRequest(client, msg) {
  const chatId = msg.from;
  const text = (msg.body || '').trim();
  
  if (!text) {
    return { handled: false };
  }
  
  // Obtener sesión existente o crear nueva
  let session = getAccessSession(chatId);
  
  // Parsear datos del mensaje actual con IA
  const parsed = await parseAccessRequestWithAI(text, session);
  
  if (DEBUG) {
    console.log('[ACCESS-REQ] parsed:', { 
      chatId: `...${chatId.slice(-10)}`, 
      parsed,
      existingSession: session ? { nombre: session.nombre, cargo: session.cargo, dept: session.departamento } : null
    });
  }
  
  // Actualizar sesión con nuevos datos (solo si vienen con valor)
  const updatedSession = updateAccessSession(chatId, {
    nombre: parsed.nombre || session?.nombre || null,
    cargo: parsed.cargo || session?.cargo || null,
    departamento: parsed.departamento || session?.departamento || null,
  });
  
  // Normalizar departamento si existe
  if (updatedSession.departamento && !updatedSession.team) {
    const deptInfo = normalizeDepartment(updatedSession.departamento);
    if (deptInfo) {
      updatedSession.team = deptInfo.team;
      updateAccessSession(chatId, { team: deptInfo.team });
    }
  }
  
  // Verificar qué datos faltan
  const missing = [];
  if (!updatedSession.nombre) missing.push('nombre');
  if (!updatedSession.cargo) missing.push('cargo');
  if (!updatedSession.departamento) missing.push('departamento');
  
  // Si el departamento no es válido, también falta
  if (updatedSession.departamento && !updatedSession.team) {
    missing.push('departamento_invalido');
  }
  
  // Si faltan datos, pedir los que faltan
  if (missing.length > 0) {
    let response = '';
    
    // Mostrar lo que ya tenemos
    const collected = [];
    if (updatedSession.nombre) collected.push(`✓ *Nombre:* ${updatedSession.nombre}`);
    if (updatedSession.cargo) collected.push(`✓ *Cargo:* ${updatedSession.cargo}`);
    if (updatedSession.departamento && updatedSession.team) {
      collected.push(`✓ *Departamento:* ${updatedSession.departamento}`);
    }
    
    if (collected.length > 0) {
      response += '📋 *Datos recibidos:*\n' + collected.join('\n') + '\n\n';
    }
    
    // Pedir lo que falta
    response += '📝 *Aún necesito:*\n';
    if (missing.includes('nombre')) {
      response += '• Tu *nombre completo*\n';
    }
    if (missing.includes('cargo')) {
      response += '• Tu *cargo* (ej: Supervisor, Auxiliar, Gerente)\n';
    }
    if (missing.includes('departamento') || missing.includes('departamento_invalido')) {
      if (missing.includes('departamento_invalido')) {
        response += `• ⚠️ *"${updatedSession.departamento}"* no es válido\n`;
      }
      response += '• Tu *departamento*: IT, Seguridad, HSKP, Room Service o Mantenimiento\n';
      
      // Limpiar departamento inválido
      if (missing.includes('departamento_invalido')) {
        updateAccessSession(chatId, { departamento: null, team: null });
      }
    }
    
    try {
      await msg.reply(response);
    } catch (e) {
      if (DEBUG) console.warn('[ACCESS-REQ] reply err:', e?.message);
    }
    
    return { handled: true, needsMoreInfo: true };
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // DATOS COMPLETOS - Enviar solicitud al admin
  // ═══════════════════════════════════════════════════════════════════════
  
  const titulo = detectTitulo(updatedSession.nombre);
  const requestData = {
    solicitanteId: chatId,
    nombre: updatedSession.nombre,
    cargo: updatedSession.cargo,
    departamento: updatedSession.departamento,
    team: updatedSession.team,
    titulo: titulo,
    requestedAt: Date.now(),
  };
  
  // Generar ID único para esta solicitud
  const requestId = `REQ-${Date.now().toString(36).toUpperCase()}`;
  requestData.requestId = requestId;
  
  // Guardar en pendientes (por requestId y por chatId)
  pendingApprovals.set(requestId, requestData);
  pendingApprovals.set(chatId, requestData);
  
  // Limpiar sesión de recolección
  clearAccessSession(chatId);
  
  // Obtener admins y enviar solicitud
  const adminIds = getAdminIds();
  
  const adminMessage = 
    `🔔 *SOLICITUD DE ACCESO* [${requestId}]\n\n` +
    `👤 *${updatedSession.nombre}*\n` +
    `💼 ${updatedSession.cargo}\n` +
    `🏢 ${updatedSession.departamento}\n` +
    `📱 ${chatId.replace('@c.us', '')}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Cita este mensaje* y responde:\n\n` +
    `✅ *si* — aprobar como usuario\n` +
    `✅ *si admin* — aprobar como administrador\n` +
    `❌ *no* — rechazar solicitud\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`;
  
  let sentToAnyAdmin = false;
  
  for (const adminId of adminIds) {
    try {
      await client.sendMessage(adminId, adminMessage);
      sentToAnyAdmin = true;
      if (DEBUG) console.log('[ACCESS-REQ] sent to admin:', adminId.slice(-10));
    } catch (e) {
      if (DEBUG) console.warn('[ACCESS-REQ] sendToAdmin err:', adminId.slice(-10), e?.message);
    }
  }
  
  // Confirmar al solicitante
  if (sentToAnyAdmin) {
    await msg.reply(
      '✅ *Solicitud enviada*\n\n' +
      `He enviado tu solicitud de acceso a los administradores.\n` +
      `Te notificaré cuando respondan.\n\n` +
      `📋 *Resumen:*\n` +
      `• Nombre: ${updatedSession.nombre}\n` +
      `• Cargo: ${updatedSession.cargo}\n` +
      `• Departamento: ${updatedSession.departamento}`
    );
  } else {
    await msg.reply(
      '⚠️ No pude enviar la solicitud a los administradores.\n' +
      'Por favor, intenta más tarde o contacta directamente al equipo de IT.'
    );
  }
  
  return { handled: true, sentToAdmin: sentToAnyAdmin };
}

/**
 * Procesa respuesta del admin (aprobar/rechazar) mediante cita
 * @param {object} client - WhatsApp client
 * @param {object} msg - Mensaje del admin
 * @returns {Promise<{handled: boolean}>}
 */
async function handleAdminDecision(client, msg) {
  const text = (msg.body || '').trim().toLowerCase();
  const adminId = msg.from;
  
  // Verificar si es un admin
  const { isAdmin } = require('./userDirectory');
  if (!isAdmin(adminId)) {
    return { handled: false };
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // MÉTODO 1: Respuesta citando el mensaje de solicitud
  // ═══════════════════════════════════════════════════════════════════════
  const quotedMsg = await getQuotedMessage(msg);
  
  if (quotedMsg) {
    const quotedText = quotedMsg.body || '';
    
    // Verificar si el mensaje citado es una solicitud de acceso
    const requestIdMatch = quotedText.match(/\[REQ-([A-Z0-9]+)\]/);
    
    if (requestIdMatch) {
      const requestId = `REQ-${requestIdMatch[1]}`;
      const foundRequest = pendingApprovals.get(requestId);
      
      if (!foundRequest) {
        await msg.reply(
          '⚠️ Esta solicitud ya fue procesada o expiró.\n\n' +
          '_Las solicitudes expiran después de 24 horas._'
        );
        return { handled: true };
      }
      
      // Parsear respuesta del admin
      const isApprove = /^(si|sí|yes|aprobar|ok|dale|va)\b/i.test(text);
      const isReject = /^(no|rechazar|nope|nel|negar)\b/i.test(text);
      const isAdminRole = /\badmin\b/i.test(text);
      
      if (!isApprove && !isReject) {
        await msg.reply(
          '🤔 No entendí tu respuesta.\n\n' +
          'Cita el mensaje y responde:\n' +
          '• *si* — aprobar como usuario\n' +
          '• *si admin* — aprobar como administrador\n' +
          '• *no* — rechazar'
        );
        return { handled: true };
      }
      
      return await processDecision(client, msg, foundRequest, isApprove, isAdminRole);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // MÉTODO 2: Comando directo (legacy) - aprobar/rechazar NUMERO
  // ═══════════════════════════════════════════════════════════════════════
  const approveMatch = text.match(/^(aprobar|approve)\s+(\d+)(?:\s+(admin))?/i);
  const rejectMatch = text.match(/^(rechazar|reject|negar)\s+(\d+)/i);
  
  if (!approveMatch && !rejectMatch) {
    return { handled: false };
  }
  
  const isApprove = !!approveMatch;
  const phoneDigits = isApprove ? approveMatch[2] : rejectMatch[2];
  const isAdminRole = isApprove && approveMatch[3];
  
  // Buscar la solicitud pendiente por número
  let foundRequest = null;
  
  for (const [key, request] of pendingApprovals.entries()) {
    if (!request.solicitanteId) continue;
    const keyDigits = request.solicitanteId.replace(/\D/g, '');
    if (keyDigits.includes(phoneDigits) || phoneDigits.includes(keyDigits.slice(-10))) {
      foundRequest = request;
      break;
    }
  }
  
  if (!foundRequest) {
    await msg.reply(
      `⚠️ No encontré una solicitud pendiente para *${phoneDigits}*.\n\n` +
      'Puede que ya haya sido procesada o el número sea incorrecto.'
    );
    return { handled: true };
  }
  
  return await processDecision(client, msg, foundRequest, isApprove, isAdminRole);
}

/**
 * Procesa la decisión del admin (aprobar/rechazar)
 */
async function processDecision(client, msg, request, isApprove, isAdminRole) {
  const waId = request.solicitanteId;
  const assignedRol = isAdminRole ? 'admin' : 'user';
  
  if (isApprove) {
    // Aprobar acceso
    const userData = {
      nombre: request.nombre,
      cargo: request.cargo,
      rol: assignedRol,
      team: request.team,
      titulo: request.titulo,
    };
    
    // Agregar a users.json
    const added = addUserToFile(waId, userData);
    
    if (added) {
      // Recargar cache
      const { reloadUsers } = require('./userDirectory');
      reloadUsers();
      
      // Notificar al solicitante
      try {
        const rolText = assignedRol === 'admin' ? ' con permisos de *administrador*' : '';
        await client.sendMessage(waId,
          '🎉 *¡Acceso aprobado!*\n\n' +
          `Bienvenido/a al sistema${rolText}, ${request.titulo} ${request.nombre}.\n\n` +
          'Ya puedes usar el bot para reportar incidencias.\n' +
          'Escribe *ayuda* si necesitas orientación.'
        );
      } catch (e) {
        if (DEBUG) console.warn('[ACCESS-REQ] notify approved err:', e?.message);
      }
      
      // Confirmar al admin
      await msg.reply(
        `✅ *Acceso aprobado*\n\n` +
        `👤 ${request.nombre}\n` +
        `🔑 Rol: *${assignedRol}*\n` +
        `🏢 Team: ${request.team}\n\n` +
        `_Usuario agregado al sistema._`
      );
      
      // Limpiar pendientes
      pendingApprovals.delete(request.requestId);
      pendingApprovals.delete(waId);
      
    } else {
      await msg.reply(
        '❌ Error al agregar el usuario al archivo.\n' +
        'Revisa los logs o agrégalo manualmente a users.json'
      );
    }
    
  } else {
    // Rechazar acceso
    try {
      await client.sendMessage(waId,
        '❌ *Solicitud de acceso rechazada*\n\n' +
        'Tu solicitud de acceso al sistema no fue aprobada.\n\n' +
        'Si crees que esto es un error, contacta directamente al equipo de IT.'
      );
    } catch (e) {
      if (DEBUG) console.warn('[ACCESS-REQ] notify rejected err:', e?.message);
    }
    
    // Confirmar al admin
    await msg.reply(
      `❌ *Acceso rechazado*\n\n` +
      `👤 ${request.nombre}\n` +
      `💼 ${request.cargo}\n\n` +
      `_El usuario ha sido notificado._`
    );
    
    // Limpiar pendientes
    pendingApprovals.delete(request.requestId);
    pendingApprovals.delete(waId);
  }
  
  return { handled: true };
}

/**
 * Obtiene el mensaje citado (si existe)
 */
async function getQuotedMessage(msg) {
  try {
    if (msg.hasQuotedMsg) {
      return await msg.getQuotedMessage();
    }
  } catch (e) {
    if (DEBUG) console.warn('[ACCESS-REQ] getQuotedMessage err:', e?.message);
  }
  return null;
}

/**
 * Verifica si hay una solicitud pendiente para este usuario
 */
function hasPendingRequest(chatId) {
  return pendingApprovals.has(chatId);
}

/**
 * Obtiene estadísticas de solicitudes pendientes
 */
function getPendingStats() {
  return {
    pendingCount: pendingApprovals.size,
    pending: Array.from(pendingApprovals.entries()).map(([id, req]) => ({
      id: id.slice(-10),
      nombre: req.nombre,
      cargo: req.cargo,
      requestedAt: new Date(req.requestedAt).toISOString(),
    })),
  };
}

module.exports = {
  getAccessDeniedMessageAsync,
  handleAccessRequest,
  handleAdminDecision,
  hasPendingRequest,
  hasActiveAccessSession: (chatId) => !!getAccessSession(chatId),
  getPendingStats,
  getDefaultDeniedMessage,
};