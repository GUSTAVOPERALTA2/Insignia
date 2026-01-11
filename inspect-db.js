const Database = require('better-sqlite3');
const db = new Database('./data/vicebot.sqlite');

console.log('Últimos tickets:\n');

const rows = db.prepare(`
  SELECT *
    FROM incidents
    ORDER BY created_at DESC;

`).all();

console.table(rows);
