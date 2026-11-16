const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'zalo_agent.db');
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar TEXT,
    zalo_id TEXT UNIQUE,
    imei TEXT,
    cookie TEXT NOT NULL,
    user_agent TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    uid TEXT NOT NULL,
    name TEXT,
    zalo_name TEXT,
    phone TEXT,
    gender TEXT,
    avatar_url TEXT,
    is_friend INTEGER DEFAULT 0,
    tags TEXT,
    extra_data TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, uid)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    group_id TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    member_count INTEGER DEFAULT 0,
    is_joined INTEGER DEFAULT 1,
    link TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    role TEXT DEFAULT 'member',
    is_friend INTEGER DEFAULT 0,
    gender TEXT,
    is_hidden INTEGER DEFAULT 0,
    phone TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, uid)
  );

  CREATE TABLE IF NOT EXISTS data_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    source TEXT DEFAULT 'scan',
    contact_type TEXT DEFAULT 'person',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS data_group_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_group_id INTEGER,
    contact_id INTEGER,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(data_group_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS phone_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    phone TEXT NOT NULL,
    has_zalo INTEGER DEFAULT 0,
    zalo_name TEXT,
    zalo_id TEXT,
    avatar_url TEXT,
    status TEXT DEFAULT 'pending',
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    account_id INTEGER,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    template TEXT NOT NULL,
    delay_min INTEGER DEFAULT 5,
    delay_max INTEGER DEFAULT 15,
    total_count INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS campaign_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: ensure new columns exist in group_members
try { db.exec('ALTER TABLE group_members ADD COLUMN is_friend INTEGER DEFAULT 0'); } catch(e){}
try { db.exec('ALTER TABLE group_members ADD COLUMN gender TEXT'); } catch(e){}
try { db.exec('ALTER TABLE group_members ADD COLUMN is_hidden INTEGER DEFAULT 0'); } catch(e){}
try { db.exec('ALTER TABLE group_members ADD COLUMN phone TEXT'); } catch(e){}

console.log('✅ SQLite Database initialized at:', dbPath);

module.exports = db;
