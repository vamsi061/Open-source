const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'repovault.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migrations for DBs created before a column existed.
// CREATE TABLE IF NOT EXISTS won't alter existing tables, so patch them here.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('recipes', 'use_venv', 'use_venv INTEGER NOT NULL DEFAULT 0');
ensureColumn('recipes', 'args', "args TEXT DEFAULT ''");
ensureColumn('runs', 'input', "input TEXT DEFAULT ''");
ensureColumn('runs', 'args', "args TEXT DEFAULT ''");

module.exports = db;
