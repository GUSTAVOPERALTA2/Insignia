const sqlite3 = require('sqlite3').verbose();
const path = require('path');
let db;

function initDB() {
  const dbPath = path.join(__dirname, '../../data/incidencias.db');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("Error al abrir la BD:", err);
    } else {
      console.log("Base de datos iniciada.");
      // Se incluye una nueva columna 'feedbackHistory' para almacenar el historial en formato JSON.
      db.run(`CREATE TABLE IF NOT EXISTS incidencias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uniqueMessageId TEXT,
                originalMsgId TEXT,
                descripcion TEXT,
                reportadoPor TEXT,
                fechaCreacion TEXT,
                estado TEXT,
                categoria TEXT,
                confirmaciones TEXT,
                feedbackHistory TEXT,
                grupoOrigen TEXT,
                media TEXT,
                fechaCancelacion TEXT
              )`);
    }
  });
}

function getDB() {
  return db;
}

function insertarIncidencia(incidencia, callback) {
  const sql = `INSERT INTO incidencias 
    (uniqueMessageId, originalMsgId, descripcion, reportadoPor, fechaCreacion, estado, categoria, confirmaciones, feedbackHistory, grupoOrigen, media) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [
    incidencia.uniqueMessageId,
    incidencia.originalMsgId,
    incidencia.descripcion,
    incidencia.reportadoPor,
    incidencia.fechaCreacion,
    incidencia.estado,
    incidencia.categoria,
    incidencia.confirmaciones ? JSON.stringify(incidencia.confirmaciones) : null,
    JSON.stringify([]), // Iniciar feedbackHistory como un arreglo vacío.
    incidencia.grupoOrigen,
    incidencia.media
  ], function(err) {
    callback(err, this.lastID);
  });
}

function buscarIncidenciaPorUniqueIdAsync(uniqueId) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM incidencias WHERE uniqueMessageId = ? LIMIT 1";
    db.get(sql, [uniqueId], (err, row) => {
      if (err) return reject(err);
      if (row && row.confirmaciones) {
        try {
          row.confirmaciones = JSON.parse(row.confirmaciones);
        } catch (e) {
          console.error("Error al parsear confirmaciones:", e);
        }
      }
      resolve(row);
    });
  });
}

function buscarIncidenciaPorOriginalMsgIdAsync(originalMsgId) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM incidencias WHERE originalMsgId = ? LIMIT 1";
    db.get(sql, [originalMsgId], (err, row) => {
      if (err) return reject(err);
      if (row && row.confirmaciones) {
        try {
          row.confirmaciones = JSON.parse(row.confirmaciones);
        } catch (e) {
          console.error("Error al parsear confirmaciones:", e);
        }
      }
      resolve(row);
    });
  });
}

function getIncidenciaById(incidenciaId, callback) {
  const sql = "SELECT * FROM incidencias WHERE id = ?";
  db.get(sql, [incidenciaId], (err, row) => {
    if (row && row.confirmaciones) {
      try {
        row.confirmaciones = JSON.parse(row.confirmaciones);
      } catch (e) {
        console.error("Error al parsear confirmaciones:", e);
      }
    }
    callback(err, row);
  });
}

function getIncidenciasByCategory(category, callback) {
  const sql = "SELECT * FROM incidencias WHERE categoria LIKE ?";
  db.all(sql, [`%${category}%`], (err, rows) => {
    if (err) {
      callback(err);
    } else {
      if (rows) {
        rows.forEach(row => {
          if (row.confirmaciones) {
            try {
              row.confirmaciones = JSON.parse(row.confirmaciones);
            } catch (e) {
              console.error("Error al parsear confirmaciones:", e);
            }
          }
        });
      }
      callback(null, rows);
    }
  });
}

function getIncidenciasByDate(date, callback) {
  const sql = "SELECT * FROM incidencias WHERE fechaCreacion LIKE ?";
  db.all(sql, [`${date}%`], (err, rows) => {
    if (err) {
      callback(err);
    } else {
      if (rows) {
        rows.forEach(row => {
          if (row.confirmaciones) {
            try {
              row.confirmaciones = JSON.parse(row.confirmaciones);
            } catch (e) {
              console.error("Error al parsear confirmaciones:", e);
            }
          }
        });
      }
      callback(null, rows);
    }
  });
}

function getIncidenciasByRange(fechaInicio, fechaFin, callback) {
  const sql = "SELECT * FROM incidencias WHERE fechaCreacion >= ? AND fechaCreacion <= ?";
  db.all(sql, [fechaInicio, fechaFin], (err, rows) => {
    if (err) {
      callback(err);
    } else {
      if (rows) {
        rows.forEach(row => {
          if (row.confirmaciones) {
            try {
              row.confirmaciones = JSON.parse(row.confirmaciones);
            } catch (e) {
              console.error("Error al parsear confirmaciones:", e);
            }
          }
        });
      }
      callback(null, rows);
    }
  });
}

function updateIncidenciaStatus(incidenciaId, estado, callback) {
  const sql = "UPDATE incidencias SET estado = ? WHERE id = ?";
  db.run(sql, [estado, incidenciaId], function(err) {
    callback(err);
  });
}

function updateConfirmaciones(incidenciaId, confirmaciones, callback) {
  const sql = "UPDATE incidencias SET confirmaciones = ? WHERE id = ?";
  db.run(sql, [confirmaciones, incidenciaId], function(err) {
    callback(err);
  });
}

/**
 * updateFeedbackHistory:
 * - Se obtiene el historial actual.
 * - Si newFeedback es un arreglo, se reemplaza el historial completo.
 * - Si newFeedback es un objeto individual, se agrega al historial.
 * - Se actualiza la BD con JSON.stringify(history) una única vez.
 */
function updateFeedbackHistory(incidenciaId, newFeedback, callback) {
  const sqlSelect = "SELECT feedbackHistory FROM incidencias WHERE id = ?";
  db.get(sqlSelect, [incidenciaId], (err, row) => {
    if (err) return callback(err);
    let history = [];
    if (row && row.feedbackHistory) {
      try {
        history = JSON.parse(row.feedbackHistory);
      } catch (e) {
        console.error("Error al parsear feedbackHistory:", e);
      }
    }
    if (Array.isArray(newFeedback)) {
      history = newFeedback;
    } else {
      history.push(newFeedback);
    }
    const sqlUpdate = "UPDATE incidencias SET feedbackHistory = ? WHERE id = ?";
    db.run(sqlUpdate, [JSON.stringify(history), incidenciaId], function(err) {
      callback(err);
    });
  });
}

function cancelarIncidencia(incidenciaId, callback) {
  const sql = "UPDATE incidencias SET estado = ?, fechaCancelacion = ? WHERE id = ? AND estado = ?";
  const fechaCancelacion = new Date().toISOString();
  console.log(`Ejecutando cancelarIncidencia para ID: ${incidenciaId} con estado 'pendiente'. Fecha cancelación: ${fechaCancelacion}`);
  db.run(sql, ["cancelada", fechaCancelacion, incidenciaId, "pendiente"], function(err) {
    if (err) {
      console.error(`Error en cancelarIncidencia para ID: ${incidenciaId}:`, err);
      callback(err);
    } else if (this.changes === 0) {
      console.warn(`cancelarIncidencia: No se actualizó ninguna incidencia para ID: ${incidenciaId}. Verifica que la incidencia exista y esté en estado 'pendiente'.`);
      callback(new Error("No se actualizó ninguna incidencia; verifica que el ID exista y que la incidencia esté en estado pendiente."));
    } else {
      console.log(`cancelarIncidencia: Incidencia ID ${incidenciaId} actualizada a 'cancelada' correctamente.`);
      callback(null);
    }
  });
}

function updateDescripcion(id, descripcion, callback) {
  const sql = "UPDATE incidencias SET descripcion = ? WHERE id = ?";
  db.run(sql, [descripcion, id], err => callback(err));
}

function updateCategoria(id, categoria, callback) {
  const sql = "UPDATE incidencias SET categoria = ? WHERE id = ?";
  db.run(sql, [categoria, id], err => callback(err));
}

module.exports = {
  initDB,
  getDB,
  insertarIncidencia,
  buscarIncidenciaPorUniqueIdAsync,
  buscarIncidenciaPorOriginalMsgIdAsync,
  getIncidenciaById,
  getIncidenciasByCategory,
  getIncidenciasByDate,
  getIncidenciasByRange,
  updateIncidenciaStatus,
  updateConfirmaciones,
  updateFeedbackHistory,
  cancelarIncidencia,
  updateDescripcion,
  updateCategoria
};
