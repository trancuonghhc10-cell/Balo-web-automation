import sqlite3
import os
import json
from datetime import datetime
from typing import List, Dict, Any, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "app.db")

def get_connection():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # Proxies Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        server TEXT NOT NULL,
        username TEXT,
        password TEXT,
        status TEXT DEFAULT 'untested',
        last_checked DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Accounts Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'zalo',
        phone TEXT,
        proxy_id INTEGER,
        status TEXT DEFAULT 'ready',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
    )
    """)

    # Campaigns Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'zalo',
        action_type TEXT NOT NULL,
        account_ids TEXT,
        parameters TEXT,
        status TEXT DEFAULT 'idle',
        progress INTEGER DEFAULT 0,
        total_targets INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Contacts / Customers Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT NOT NULL,
        group_name TEXT DEFAULT 'Mặc định',
        tag TEXT,
        status TEXT DEFAULT 'new',
        last_contacted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Logs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        account_id INTEGER,
        level TEXT DEFAULT 'INFO',
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Auto Replies Table (Chatbot / Auto-Responder)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS auto_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        keyword TEXT NOT NULL,
        match_type TEXT DEFAULT 'contains',
        reply_message TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
    """)

    conn.commit()
    conn.close()

# --- Proxy Operations ---
def list_proxies() -> List[Dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute("SELECT * FROM proxies ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_proxy(proxy_id: int) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    row = conn.execute("SELECT * FROM proxies WHERE id = ?", (proxy_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def create_proxy(name: str, server: str, username: str = None, password: str = None) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO proxies (name, server, username, password) VALUES (?, ?, ?, ?)",
        (name, server, username, password)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    return new_id

def update_proxy_status(proxy_id: int, status: str):
    conn = get_connection()
    conn.execute(
        "UPDATE proxies SET status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?",
        (status, proxy_id)
    )
    conn.commit()
    conn.close()

def delete_proxy(proxy_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM proxies WHERE id = ?", (proxy_id,))
    conn.commit()
    conn.close()

# --- Account Operations ---
def list_accounts() -> List[Dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute("""
        SELECT a.*, p.name as proxy_name, p.server as proxy_server 
        FROM accounts a 
        LEFT JOIN proxies p ON a.proxy_id = p.id 
        ORDER BY a.id DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_account(account_id: int) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def create_account(name: str, platform: str = 'zalo', phone: str = None, proxy_id: int = None, notes: str = None) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO accounts (name, platform, phone, proxy_id, notes) VALUES (?, ?, ?, ?, ?)",
        (name, platform, phone, proxy_id, notes)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    return new_id

def update_account_status(account_id: int, status: str):
    conn = get_connection()
    conn.execute(
        "UPDATE accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (status, account_id)
    )
    conn.commit()
    conn.close()

def delete_account(account_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    conn.commit()
    conn.close()

# --- Campaign Operations ---
def list_campaigns() -> List[Dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute("SELECT * FROM campaigns ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_campaign(campaign_id: int) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    row = conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def create_campaign(name: str, platform: str, action_type: str, account_ids: List[int], parameters: Dict[str, Any]) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO campaigns (name, platform, action_type, account_ids, parameters, total_targets)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (name, platform, action_type, json.dumps(account_ids), json.dumps(parameters), len(parameters.get("targets", [])))
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    return new_id

def update_campaign_progress(campaign_id: int, progress: int, success: int = 0, fail: int = 0, status: str = None):
    conn = get_connection()
    if status:
        conn.execute(
            """
            UPDATE campaigns 
            SET progress = ?, success_count = ?, fail_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
            """,
            (progress, success, fail, status, campaign_id)
        )
    else:
        conn.execute(
            """
            UPDATE campaigns 
            SET progress = ?, success_count = ?, fail_count = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
            """,
            (progress, success, fail, campaign_id)
        )
    conn.commit()
    conn.close()

# --- Logs Operations ---
def add_log(message: str, level: str = 'INFO', campaign_id: int = None, account_id: int = None):
    conn = get_connection()
    conn.execute(
        "INSERT INTO logs (campaign_id, account_id, level, message) VALUES (?, ?, ?, ?)",
        (campaign_id, account_id, level, message)
    )
    conn.commit()
    conn.close()

def get_recent_logs(limit: int = 100) -> List[Dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]

# --- Contact Operations ---
def list_contacts(group_name: str = None, limit: int = 500) -> List[Dict[str, Any]]:
    conn = get_connection()
    if group_name:
        rows = conn.execute(
            "SELECT * FROM contacts WHERE group_name = ? ORDER BY id DESC LIMIT ?",
            (group_name, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM contacts ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_contact_groups() -> List[str]:
    conn = get_connection()
    rows = conn.execute("SELECT DISTINCT group_name FROM contacts WHERE group_name IS NOT NULL").fetchall()
    conn.close()
    return [r[0] for r in rows]

def bulk_add_contacts(contacts_data: List[Dict[str, Any]]) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    added = 0
    for c in contacts_data:
        phone = str(c.get("phone", "")).strip()
        if not phone:
            continue
        # Standardize phone number (e.g. 849xxx -> 09xxx)
        if phone.startswith("84") and len(phone) >= 11:
            phone = "0" + phone[2:]
        elif phone.startswith("+84") and len(phone) >= 12:
            phone = "0" + phone[3:]
        
        name = (c.get("name") or "").strip() or f"Khách {phone}"
        group_name = (c.get("group_name") or "Mặc định").strip() or "Mặc định"
        tag = (c.get("tag") or "").strip()

        cursor.execute(
            "INSERT INTO contacts (name, phone, group_name, tag) VALUES (?, ?, ?, ?)",
            (name, phone, group_name, tag)
        )
        added += 1
    conn.commit()
    conn.close()
    return added

def delete_contact(contact_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    conn.commit()
    conn.close()

def clear_contacts(group_name: str = None):
    conn = get_connection()
    if group_name:
        conn.execute("DELETE FROM contacts WHERE group_name = ?", (group_name,))
    else:
        conn.execute("DELETE FROM contacts")
    conn.commit()
    conn.close()

def count_contacts() -> int:
    conn = get_connection()
    count = conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
    conn.close()
    return count

# --- Auto Reply Rules Operations ---
def list_auto_replies(account_id: Optional[int] = None) -> List[Dict[str, Any]]:
    conn = get_connection()
    if account_id:
        rows = conn.execute("SELECT r.*, a.name as account_name FROM auto_replies r LEFT JOIN accounts a ON r.account_id = a.id WHERE r.account_id = ? ORDER BY r.id DESC", (account_id,)).fetchall()
    else:
        rows = conn.execute("SELECT r.*, a.name as account_name FROM auto_replies r LEFT JOIN accounts a ON r.account_id = a.id ORDER BY r.id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def create_auto_reply(account_id: int, keyword: str, reply_message: str, match_type: str = "contains") -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO auto_replies (account_id, keyword, reply_message, match_type) VALUES (?, ?, ?, ?)",
        (account_id, keyword.strip(), reply_message.strip(), match_type)
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    return new_id

def delete_auto_reply(rule_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM auto_replies WHERE id = ?", (rule_id,))
    conn.commit()
    conn.close()

def toggle_auto_reply(rule_id: int, is_active: int):
    conn = get_connection()
    conn.execute("UPDATE auto_replies SET is_active = ? WHERE id = ?", (is_active, rule_id))
    conn.commit()
    conn.close()


