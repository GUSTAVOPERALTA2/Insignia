const config = require('../../config/config');
const incidenceDB = require('./incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
// Importamos funciones de stringUtils incluyendo la adaptativa
const { normalizeText, similarity, adaptiveSimilarityCheck } = require('../../config/stringUtils');

async function processNewIncidence(client, message) {
  const chat = await message.getChat();
  const chatId = chat.id._serialized;
  console.log("Procesando mensaje de Grupo de Incidencias.");

  // Normalizamos y limpiamos el mensaje eliminando diacríticos y signos de puntuación
  const normalizedMessage = normalizeText(message.body);
  const cleanedMessage = normalizedMessage.replace(/[.,!?()]/g, '');
  console.log(`Mensaje original: "${message.body}"`);
  console.log(`Mensaje normalizado y limpio: "${cleanedMessage}"`);

  if (!cleanedMessage.trim()) {
    console.log("El mensaje está vacío tras la limpieza. Se omite.");
    return;
  }
  // Se crea un conjunto de palabras del mensaje
  const wordsSet = new Set(cleanedMessage.split(/\s+/));
  console.log("Conjunto de palabras del mensaje:", wordsSet);

  // Se evalúan las categorías para incidencias: it, ama y man
  const categories = ['it', 'ama', 'man'];
  let foundCategories = [];
  const keywordsData = client.keywordsData;
  for (let category of categories) {
    const data = keywordsData.identificadores[category];
    if (!data) continue;
    
    // Evaluación de palabras clave: se recorre cada palabra clave
    const foundKeyword = data.palabras.some(keyword => {
      const normalizedKeyword = normalizeText(keyword);
      let keywordFound = false;
      Array.from(wordsSet).forEach(word => {
        const sim = similarity(word, normalizedKeyword);
        console.log(`Comparando palabra del mensaje: "${word}" vs keyword: "${normalizedKeyword}" → Similitud: ${sim}`);
        if (adaptiveSimilarityCheck(word, normalizedKeyword)) {
          keywordFound = true;
        }
      });
      if (keywordFound) {
        console.log(`Coincidencia detectada en categoría "${category}" para la palabra clave: "${keyword}"`);
      }
      return keywordFound;
    });

    // Evaluación de frases clave
    const foundPhrase = data.frases.some(phrase => {
      const normalizedPhrase = normalizeText(phrase);
      const included = normalizedMessage.includes(normalizedPhrase);
      console.log(`Verificando frase clave: "${phrase}" (normalizada: "${normalizedPhrase}") → Incluida en mensaje: ${included}`);
      return included;
    });
    
    console.log(`Evaluando categoría "${category}": foundKeyword=${foundKeyword}, foundPhrase=${foundPhrase}`);
    if (foundKeyword || foundPhrase) {
      foundCategories.push(category);
    }
  }
  console.log("Categorías detectadas:", foundCategories);

  if (!foundCategories.length) {
    console.log("No se encontró ninguna categoría en el mensaje.");
    return;
  }
  console.log(`Registrando incidencia para las categorías ${foundCategories.join(', ')}: "${message.body}"`);

  let confirmaciones = null;
  if (foundCategories.length > 1) {
    confirmaciones = {};
    foundCategories.forEach(cat => {
      confirmaciones[cat] = false;
    });
  }
  // Descargar la media y conservar data + mimetype
  let mediaData = null;
  if (message.hasMedia) {
    try {
      const media = await message.downloadMedia();
      if (media && media.data && media.mimetype) {
        mediaData = { data: media.data, mimetype: media.mimetype };
        console.log("Media descargada correctamente:", mediaData.mimetype);
      } else {
        console.log("Media descargada, pero no se encontró data o mimetype.");
      }
    } catch (err) {
      console.error("Error al descargar la media:", err);
    }
  }
  
  // Generar identificador único y preparar la incidencia
  const uniqueMessageId = uuidv4();
  const originalMsgId = message.id._serialized;

  const nuevaIncidencia = {
    uniqueMessageId,
    originalMsgId,
    descripcion: message.body,
    reportadoPor: message.author ? message.author : message.from,
    fechaCreacion: new Date().toISOString(),
    estado: "pendiente",
    categoria: foundCategories.join(', '),
    confirmaciones: confirmaciones,
    grupoOrigen: chatId,
    media: mediaData ? JSON.stringify(mediaData) : null
  };
  
  incidenceDB.insertarIncidencia(nuevaIncidencia, async (err, lastID) => {
    if (err) {
      console.error("Error al insertar incidencia en SQLite:", err);
    } else {
      console.log("Incidencia registrada con ID:", lastID);

      // Función para reenviar la incidencia a los grupos destino
      async function forwardMessage(targetGroupId, categoryLabel) {
        try {
          const targetChat = await client.getChatById(targetGroupId);
          const mensajeConID = 
            `*Nueva tarea recibida (ID: ${lastID}):*\n\n` +
            `✅ *${message.body}*`;
            ;
          if (mediaData && mediaData.data && mediaData.mimetype) {
            console.log(`Enviando mensaje con media a ${categoryLabel}...`);
            const mediaMessage = new MessageMedia(mediaData.mimetype, mediaData.data);
            await targetChat.sendMessage(mediaMessage, { caption: mensajeConID });
          } else {
            await targetChat.sendMessage(mensajeConID);
          }
          console.log(`Mensaje reenviado a ${categoryLabel}: ${mensajeConID}`);
        } catch (error) {
          console.error(`Error al reenviar mensaje a ${categoryLabel}:`, error);
        }
      }
      if (foundCategories.includes('it')) {
        await forwardMessage(config.groupBotDestinoId, 'IT');
      }
      if (foundCategories.includes('man')) {
        await forwardMessage(config.groupMantenimientoId, 'Mantenimiento');
      }
      if (foundCategories.includes('ama')) {
        await forwardMessage(config.groupAmaId, 'Ama de Llaves');
      }

      const teamNames = { it: "IT", ama: "Ama de Llaves", man: "Mantenimiento" };
      const teams = foundCategories.map(cat => teamNames[cat]);
      let teamList;
      if (teams.length === 1) {
        teamList = teams[0];
      } else if (teams.length === 2) {
        teamList = teams.join(" y ");
      } else if (teams.length >= 3) {
        teamList = teams.slice(0, teams.length - 1).join(", ") + " y " + teams[teams.length - 1];
      }
      await chat.sendMessage(`*🤖 El mensaje se ha enviado al equipo:* \n\n ✅ ${teamList}\n\n*ID: ${lastID}*`);
    }
  });
}

module.exports = { processNewIncidence };