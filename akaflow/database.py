from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


DATA_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "akaflow.db"


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
    try:
        os.chmod(DB_PATH, 0o600)
    except FileNotFoundError:
        pass


def init_db() -> None:
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER,
                external_id TEXT,
                name TEXT NOT NULL,
                phone TEXT DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                tags TEXT NOT NULL DEFAULT '',
                consent_status TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (consent_status IN ('unknown', 'granted', 'revoked')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(account_id, external_id),
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                message TEXT NOT NULL,
                delay_seconds INTEGER NOT NULL DEFAULT 8,
                dry_run INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                total INTEGER NOT NULL DEFAULT 0,
                sent INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS campaign_targets (
                campaign_id INTEGER NOT NULL,
                contact_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                detail TEXT DEFAULT '',
                PRIMARY KEY (campaign_id, contact_id),
                FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )


def rows(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with connection() as conn:
        return [dict(row) for row in conn.execute(query, params).fetchall()]


def row(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with connection() as conn:
        found = conn.execute(query, params).fetchone()
        return dict(found) if found else None


def execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with connection() as conn:
        cursor = conn.execute(query, params)
        return int(cursor.lastrowid or 0)


def audit(action: str, detail: dict[str, Any] | None = None) -> None:
    execute(
        "INSERT INTO audit_log(action, detail) VALUES (?, ?)",
        (action, json.dumps(detail or {}, ensure_ascii=False)),
    )
