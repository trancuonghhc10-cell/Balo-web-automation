from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
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

            CREATE TABLE IF NOT EXISTS observed_members (
                account_id INTEGER NOT NULL,
                group_id TEXT NOT NULL,
                uid TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                avatar TEXT NOT NULL DEFAULT '',
                source_types TEXT NOT NULL DEFAULT '[]',
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                evidence_count INTEGER NOT NULL DEFAULT 1,
                last_event_type TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (account_id, group_id, uid),
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_observed_members_group
            ON observed_members(account_id, group_id, last_seen_at DESC);

            CREATE TABLE IF NOT EXISTS facebook_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                last_opened_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS facebook_drafts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                target_type TEXT NOT NULL
                    CHECK (target_type IN ('profile', 'group')),
                target_url TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'opened', 'published', 'cancelled')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE
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


def observe_member(event: dict[str, Any]) -> bool:
    try:
        account_id = int(event.get("account_id"))
    except (TypeError, ValueError):
        return False

    group_id = str(event.get("group_id") or "").strip()
    uid = str(event.get("uid") or "").strip()
    source = str(event.get("source") or "").strip()[:100]
    if not group_id.isdigit() or not uid.isdigit() or not source:
        return False

    display_name = str(event.get("display_name") or "").strip()[:200]
    avatar = str(event.get("avatar") or "").strip()[:1000]
    event_at = str(event.get("event_at") or "").strip()[:40]
    if not event_at:
        event_at = datetime.now(UTC).isoformat()

    with connection() as conn:
        if not conn.execute(
            "SELECT 1 FROM accounts WHERE id = ?", (account_id,)
        ).fetchone():
            return False

        existing = conn.execute(
            """
            SELECT source_types FROM observed_members
            WHERE account_id = ? AND group_id = ? AND uid = ?
            """,
            (account_id, group_id, uid),
        ).fetchone()
        sources: list[str] = []
        if existing:
            try:
                sources = list(json.loads(existing["source_types"] or "[]"))
            except (TypeError, ValueError, json.JSONDecodeError):
                sources = []
        if source not in sources:
            sources.append(source)
        sources = sources[-20:]

        conn.execute(
            """
            INSERT INTO observed_members(
                account_id, group_id, uid, display_name, avatar,
                source_types, first_seen_at, last_seen_at,
                evidence_count, last_event_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(account_id, group_id, uid) DO UPDATE SET
                display_name = CASE
                    WHEN excluded.display_name != '' THEN excluded.display_name
                    ELSE observed_members.display_name
                END,
                avatar = CASE
                    WHEN excluded.avatar != '' THEN excluded.avatar
                    ELSE observed_members.avatar
                END,
                source_types = excluded.source_types,
                last_seen_at = excluded.last_seen_at,
                evidence_count = observed_members.evidence_count + 1,
                last_event_type = excluded.last_event_type
            """,
            (
                account_id,
                group_id,
                uid,
                display_name,
                avatar,
                json.dumps(sources, ensure_ascii=False),
                event_at,
                event_at,
                source,
            ),
        )
    return True


def observed_members(account_id: int, group_id: str) -> list[dict[str, Any]]:
    items = rows(
        """
        SELECT * FROM observed_members
        WHERE account_id = ? AND group_id = ?
        ORDER BY last_seen_at DESC, evidence_count DESC
        """,
        (account_id, group_id),
    )
    for item in items:
        try:
            item["sources"] = json.loads(item.pop("source_types") or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            item["sources"] = []
    return items


def observation_summary(account_id: int | None = None) -> dict[str, int]:
    where = "WHERE account_id = ?" if account_id is not None else ""
    params: tuple[Any, ...] = (account_id,) if account_id is not None else ()
    found = row(
        f"""
        SELECT COUNT(*) AS members, COUNT(DISTINCT group_id) AS groups,
               COALESCE(SUM(evidence_count), 0) AS events
        FROM observed_members {where}
        """,
        params,
    ) or {}
    return {
        "members": int(found.get("members") or 0),
        "groups": int(found.get("groups") or 0),
        "events": int(found.get("events") or 0),
    }
