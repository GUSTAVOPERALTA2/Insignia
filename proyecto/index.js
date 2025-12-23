const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { startReminder } = require('./config/autoReminder');
const { loadKeywords } = require('./config/keywordsManager');
const incidenciasDB = require('./modules/incidenceManager/incidenceDB');
const { setupEditHandler } = require('./modules/messageManager/editHandler');

// Inicializamos la base de datos SQLite
incidenciasDB.initDB();
// Creamos el cliente de WhatsApp con autenticación local
const client = new Client({
  authStrategy: new LocalAuth()
});

// Cargamos las keywords y las asignamos al cliente
client.keywordsData = loadKeywords();

// Evento para generar el QR en consola
client.on('qr', qr => {
  console.log('Escanea este QR con WhatsApp Web:');
  qrcode.generate(qr, { small: true });
});

// Cuando el cliente esté listo, iniciamos recordatorios y mostramos información de chats
client.on('ready', async () => {
  console.log('Bot de WhatsApp conectado y listo.');
  startReminder(client);
  const chats = await client.getChats();
  console.log(`Chats disponibles: ${chats.length}`);
  const groups = chats.filter(chat => chat.id._serialized.endsWith('@g.us'));
  console.log(`Grupos disponibles: ${groups.length}`);
  groups.forEach(group => {
    console.log(`Grupo: ${group.name} - ID: ${group.id._serialized}`);
  });
});

// Delegamos el procesamiento de mensajes al manejador de mensajes
client.on('message', async message => {
  const messageHandler = require('./modules/messageManager/messageHandler');
  await messageHandler(client, message);
});

// Inicializamos el cliente para comenzar a escuchar mensajes
client.initialize();
setupEditHandler(client);

//ESTRUCTURA FINAL