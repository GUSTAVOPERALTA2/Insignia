// config/exportXLSX.js
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { formatDate } = require('./dateUtils');  // Importa el formateador

/**
 * exportXLSX - Exporta las incidencias de la BD a un archivo XLSX.
 * Genera dos hojas:
 *   • "Incidencias": Datos principales de cada incidencia.
 *   • "Feedback": Cada registro de feedback (desnormalizado) en filas separadas, asociado a la incidencia.
 * Se omiten campos no relevantes (uniqueMessageId, originalMsgId, grupoOrigen, media).
 *
 * @returns {Promise<string>} - Promesa que se resuelve con la ruta del archivo XLSX generado.
 */
function exportXLSX() {
  return new Promise((resolve, reject) => {
    // Ruta a la base de datos (desde /config, subimos a /data)
    const dbPath = path.join(__dirname, '../data/incidencias.db');
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error("Error al abrir la BD:", err);
        return reject(err);
      }
      console.log("Base de datos abierta correctamente.");
    });

    // Consulta: Seleccionamos solo las col
    //Columnas relevantes
    const sql = `
      SELECT id, descripcion, reportadoPor, fechaCreacion, estado, categoria, confirmaciones, feedbackHistory, fechaCancelacion
      FROM incidencias
    `;
    db.all(sql, async (err, rows) => {
      if (err) {
        console.error("Error al leer la BD:", err);
        db.close();
        return reject(err);
      }
      if (!rows || rows.length === 0) {
        console.log("No se encontraron incidencias.");
        db.close();
        return reject(new Error("No hay incidencias"));
      }

      // Crear el workbook
      const workbook = new ExcelJS.Workbook();

      // Hoja "Incidencias": datos principales
      const incidenciasSheet = workbook.addWorksheet('Incidencias');
      incidenciasSheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Descripción', key: 'descripcion', width: 40 },
        { header: 'Reportado Por', key: 'reportadoPor', width: 20 },
        { header: 'Fecha Creación', key: 'fechaCreacion', width: 20 },
        { header: 'Estado', key: 'estado', width: 15 },
        { header: 'Categoría', key: 'categoria', width: 20 },
        { header: 'Confirmaciones', key: 'confirmaciones', width: 30 },
        { header: 'Fecha Cancelación', key: 'fechaCancelacion', width: 20 }
      ];

      // Hoja "Feedback": desnormalización de feedbackHistory
      const feedbackSheet = workbook.addWorksheet('Feedback');
      feedbackSheet.columns = [
        { header: 'Incidencia ID', key: 'incidenciaId', width: 10 },
        { header: 'Equipo', key: 'equipo', width: 10 },
        { header: 'Comentario', key: 'comentario', width: 40 },
        { header: 'Fecha', key: 'fecha', width: 20 }
      ];

      // Procesar cada incidencia
      rows.forEach(row => {
        // Formatear confirmaciones: parseamos y separamos con salto de línea
        let confirmacionesFormatted = "";
        if (row.confirmaciones) {
          try {
            const conf = JSON.parse(row.confirmaciones);
            if (conf && typeof conf === 'object') {
              confirmacionesFormatted = Object.entries(conf)
                .map(([key, val]) => {
                  let formattedVal = val;
                  if (val && !isNaN(Date.parse(val))) {
                    formattedVal = new Date(val).toLocaleString();
                  }
                  return `${key.toUpperCase()}: ${formattedVal}`;
                })
                .join("\n");
            } else {
              confirmacionesFormatted = row.confirmaciones;
            }
          } catch (e) {
            confirmacionesFormatted = row.confirmaciones;
          }
        }

        // Agregar la incidencia a la hoja "Incidencias"
        incidenciasSheet.addRow({
          id: row.id,
          descripcion: row.descripcion,
          reportadoPor: row.reportadoPor,
          fechaCreacion: formatDate(row.fechaCreacion),
          estado: row.estado,
          categoria: row.categoria,
          confirmaciones: confirmacionesFormatted,
          fechaCancelacion: formatDate(row.fechaCancelacion)
        });

        // Desnormalizar el feedback: cada registro en una fila de "Feedback"
        if (row.feedbackHistory) {
          try {
            const feedbackArray = JSON.parse(row.feedbackHistory);
            if (Array.isArray(feedbackArray)) {
              feedbackArray.forEach(fb => {
                feedbackSheet.addRow({
                  incidenciaId: row.id,
                  equipo: fb.equipo || '',
                  comentario: fb.comentario || '',
                  fecha: fb.fecha || ''
                });
              });
            }
          } catch (e) {
            console.error(`Error parseando feedbackHistory para incidencia ${row.id}:`, e);
          }
        }
      });

      // Dar formato a los encabezados (opcional: negrita)
      [incidenciasSheet, feedbackSheet].forEach(sheet => {
        sheet.getRow(1).font = { bold: true };
      });

      // Ruta de salida para el XLSX
      const outputPath = path.join(__dirname, '../data/incidencias_export.xlsx');
      workbook.xlsx.writeFile(outputPath)
        .then(() => {
          console.log("Archivo XLSX generado en:", outputPath);
          db.close();
          resolve(outputPath);
        })
        .catch(err => {
          console.error("Error al escribir XLSX:", err);
          db.close();
          reject(err);
        });
    });
  });
}

module.exports = { exportXLSX };

if (require.main === module) {
  exportXLSX()
    .then(outputPath => console.log("Reporte XLSX generado en:", outputPath))
    .catch(err => console.error("Error:", err));
}
