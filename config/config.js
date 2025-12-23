// config/config.js
// Configuración mínima para flujo N-I (IA-first)

const TZ = process.env.VICEBOT_TZ || 'America/Mazatlan';

// IDs de grupos destino por área (WhatsApp group JIDs: "<digits>@g.us").
// Puedes definirlos en .env como GROUP_IT_ID, GROUP_MAN_ID, etc.
const destinoGrupos = {
  it : process.env.GROUP_IT_ID  || '00000000000-1111111111@g.us',   // Sistemas / IT
  man: process.env.GROUP_MAN_ID || '00000000000-2222222222@g.us',   // Mantenimiento
  ama: process.env.GROUP_AMA_ID || '00000000000-3333333333@g.us',   // HSKP / Ama de llaves
  rs : process.env.GROUP_RS_ID  || '00000000000-4444444444@g.us',   // Room Service
  seg: process.env.GROUP_SEG_ID || '00000000000-5555555555@g.us',   // Seguridad
};

// (Opcional) Grupo principal para avisos globales
const groupPruebaId =
  process.env.GROUP_MAIN_ID || '00000000000-9999999999@g.us';

// Nombre del bot para mensajes
const BOT_NAME = process.env.BOT_NAME || 'Vicebot';

module.exports = {
  TZ,
  BOT_NAME,
  destinoGrupos,
  groupPruebaId,
};
