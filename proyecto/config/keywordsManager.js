const fs = require('fs');
const config = require('./config');

function loadKeywords() {
  try {
    const data = fs.readFileSync(config.keywordsFile, 'utf8');
    const jsonData = JSON.parse(data);
    console.log("Keywords JSON loaded:", jsonData);
    return jsonData;
  } catch (error) {
    console.error("Error loading keywords JSON:", error);
    return {
      identificadores: {
        it: { palabras: [], frases: [] },
        ama: { palabras: [], frases: [] },
        man: { palabras: [], frases: [] }
      },
      confirmacion: {
        frases: [],
        palabras: []
      }
    };
  }
}

function saveKeywords(keywordsData) {
  try {
    fs.writeFileSync(config.keywordsFile, JSON.stringify(keywordsData, null, 2), 'utf8');
    console.log("Keywords JSON saved successfully.");
    return true;
  } catch (error) {
    console.error("Error saving keywords JSON:", error);
    return false;
  }
}

function addEntry(category, type, entry) {
  const data = loadKeywords();
  entry = entry.toLowerCase().trim();
  let targetArray;
  if (['it', 'ama', 'man'].includes(category)) {
    if (type === 'p') {
      targetArray = data.identificadores[category].palabras;
    } else if (type === 'f') {
      targetArray = data.identificadores[category].frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else if (category === 'confirmacion') {
    if (type === 'p') {
      targetArray = data.confirmacion.palabras;
    } else if (type === 'f') {
      targetArray = data.confirmacion.frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else {
    console.error(`Categoría inválida: ${category}.`);
    return false;
  }
  if (targetArray.includes(entry)) {
    console.log("La entrada ya existe.");
    return false;
  }
  targetArray.push(entry);
  return saveKeywords(data);
}

function removeEntry(category, type, entry) {
  const data = loadKeywords();
  entry = entry.toLowerCase().trim();
  let targetArray;
  if (['it', 'ama', 'man'].includes(category)) {
    if (type === 'p') {
      targetArray = data.identificadores[category].palabras;
    } else if (type === 'f') {
      targetArray = data.identificadores[category].frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else if (category === 'confirmacion') {
    if (type === 'p') {
      targetArray = data.confirmacion.palabras;
    } else if (type === 'f') {
      targetArray = data.confirmacion.frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else {
    console.error(`Categoría inválida: ${category}.`);
    return false;
  }
  const index = targetArray.indexOf(entry);
  if (index === -1) {
    console.log("La entrada no existe.");
    return false;
  }
  targetArray.splice(index, 1);
  return saveKeywords(data);
}

function editEntry(category, type, oldEntry, newEntry) {
  const data = loadKeywords();
  oldEntry = oldEntry.toLowerCase().trim();
  newEntry = newEntry.toLowerCase().trim();
  let targetArray;
  if (['it', 'ama', 'man'].includes(category)) {
    if (type === 'p') {
      targetArray = data.identificadores[category].palabras;
    } else if (type === 'f') {
      targetArray = data.identificadores[category].frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else if (category === 'confirmacion') {
    if (type === 'p') {
      targetArray = data.confirmacion.palabras;
    } else if (type === 'f') {
      targetArray = data.confirmacion.frases;
    } else {
      console.error("Tipo inválido. Use 'p' para palabra o 'f' para frase.");
      return false;
    }
  } else {
    console.error(`Categoría inválida: ${category}.`);
    return false;
  }
  const index = targetArray.indexOf(oldEntry);
  if (index === -1) {
    console.log("La entrada antigua no existe.");
    return false;
  }
  if (targetArray.includes(newEntry)) {
    console.log("La nueva entrada ya existe.");
    return false;
  }
  targetArray[index] = newEntry;
  return saveKeywords(data);
}

module.exports = {
  loadKeywords,
  addEntry,
  removeEntry,
  editEntry
};


//Manager final