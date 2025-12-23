// modules/messageManager/editHandler.js
const incidenceDB = require('../../modules/incidenceManager/incidenceDB');
const config      = require('../../config/config');

function setupEditHandler(client) {
  client.on('message_update', async (oldMessage, newMessage) => {
    try {
      // 1) Solo texto
      if (!newMessage.body) return;

      // 2) ¿Corresponde a una incidencia existente?
      const inc = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(
        newMessage.id._serialized
      );
      if (!inc) return;

      console.log(
        `Mensaje editado detectado (incidencia ${inc.id}): "${newMessage.body}"`
      );

      // 3) Recalcula categorías
      const text = newMessage.body.toLowerCase();
      const cats = [];
      for (const cat of ['it','man','ama']) {
        const data = client.keywordsData.identificadores[cat];
        if (!data) continue;
        if (
          data.palabras.some(w => text.includes(w)) ||
          data.frases .some(f => text.includes(f))
        ) cats.push(cat);
      }
      const newCategoria = cats.join(',');

      // 4) Actualiza categoría si cambió
      if (newCategoria && newCategoria !== inc.categoria) {
        incidenceDB.updateCategoria(inc.id, newCategoria, err => {
          if (err) console.error(err);
          else {
            console.log(
              `Categoria de incidencia ${inc.id}: ${inc.categoria} → ${newCategoria}`
            );
            client.getChatById(config.groupPruebaId)
              .then(main =>
                main.sendMessage(
                  `*Incidencia ${inc.id} recategorizada:* ${inc.categoria} → ${newCategoria}`
                )
              );
          }
        });
      }

      // 5) Actualiza descripción
      incidenceDB.updateDescripcion(inc.id, newMessage.body, err => {
        if (err) console.error(err);
        else console.log(`Descripción de incidencia ${inc.id} actualizada.`);
      });

    } catch (e) {
      console.error("Error en editHandler:", e);
    }
  });
}

module.exports = { setupEditHandler };