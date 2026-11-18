from __future__ import annotations

import asyncio
import csv
import io
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

import database as db
from connector import zalo


BASE_DIR = Path(__file__).resolve().parent
app = FastAPI(title="AkaFlow", docs_url=None, redoc_url=None)


@app.on_event("startup")
def startup() -> None:
    db.init_db()


@app.get("/", response_class=HTMLResponse)
def dashboard() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    connector = await zalo.health()
    return {"status": "ok", "connector": connector}


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=500)


@app.get("/api/accounts")
async def accounts() -> list[dict[str, Any]]:
    items = db.rows("SELECT * FROM accounts ORDER BY id DESC")
    for item in items:
        try:
            item["session"] = await zalo.session_status(item["id"])
        except Exception as exc:
            item["session"] = {"active": False, "error": str(exc)}
    return items


@app.post("/api/accounts")
def create_account(payload: AccountIn) -> dict[str, Any]:
    account_id = db.execute(
        "INSERT INTO accounts(name, notes) VALUES (?, ?)",
        (payload.name.strip(), payload.notes.strip()),
    )
    db.audit("account.created", {"account_id": account_id})
    return {"success": True, "id": account_id}


@app.post("/api/accounts/{account_id}/qr/start")
async def qr_start(account_id: int) -> dict[str, Any]:
    if not db.row("SELECT id FROM accounts WHERE id = ?", (account_id,)):
        raise HTTPException(404, "Không tìm thấy tài khoản")
    result = await zalo.qr_start(account_id)
    db.audit("account.qr_started", {"account_id": account_id})
    return result


@app.get("/api/accounts/{account_id}/qr/status")
async def qr_status(account_id: int) -> dict[str, Any]:
    return await zalo.qr_status(account_id)


@app.get("/api/accounts/{account_id}/groups")
async def groups(account_id: int) -> dict[str, Any]:
    return await zalo.groups(account_id)


@app.get("/api/accounts/{account_id}/groups/{group_id}/members")
async def group_members(account_id: int, group_id: str) -> dict[str, Any]:
    result = await zalo.group_members(account_id, group_id)
    db.audit(
        "group.members_viewed",
        {
            "account_id": account_id,
            "group_id": group_id,
            "count": len(result.get("items", [])),
            "hidden": bool(result.get("is_hidden_members")),
        },
    )
    return result


@app.post("/api/accounts/{account_id}/groups/{group_id}/import")
async def import_group_members(account_id: int, group_id: str) -> dict[str, Any]:
    result = await zalo.group_members(account_id, group_id)
    items = result.get("items", []) if result.get("success") else []
    imported = 0
    with db.connection() as conn:
        for item in items:
            external_id = str(item.get("uid") or item.get("id") or "").strip()
            if not external_id:
                continue
            conn.execute(
                """
                INSERT INTO contacts(account_id, external_id, name, source, tags, consent_status)
                VALUES (?, ?, ?, 'zalo_group', ?, 'unknown')
                ON CONFLICT(account_id, external_id) DO UPDATE SET
                    name = excluded.name,
                    tags = CASE
                        WHEN contacts.tags = '' THEN excluded.tags
                        WHEN instr(contacts.tags, excluded.tags) > 0 THEN contacts.tags
                        ELSE contacts.tags || ',' || excluded.tags
                    END
                """,
                (
                    account_id,
                    external_id,
                    item.get("name") or f"Zalo {external_id}",
                    f"group:{group_id}",
                ),
            )
            imported += 1
    db.audit(
        "group.members_imported",
        {"account_id": account_id, "group_id": group_id, "count": imported},
    )
    return {"success": True, "count": imported, "message": result.get("message")}


@app.post("/api/accounts/{account_id}/friends/sync")
async def sync_friends(account_id: int) -> dict[str, Any]:
    result = await zalo.friends(account_id)
    items = result.get("items", []) if result.get("success") else []
    with db.connection() as conn:
        for item in items:
            external_id = str(item.get("uid") or item.get("id") or "").strip()
            if not external_id:
                continue
            conn.execute(
                """
                INSERT INTO contacts(account_id, external_id, name, phone, source, consent_status)
                VALUES (?, ?, ?, ?, 'zalo_friend', 'unknown')
                ON CONFLICT(account_id, external_id) DO UPDATE SET
                    name = excluded.name,
                    phone = excluded.phone
                """,
                (
                    account_id,
                    external_id,
                    item.get("name") or f"Zalo {external_id}",
                    item.get("phone") or "",
                ),
            )
    db.audit("friends.synced", {"account_id": account_id, "count": len(items)})
    return {"success": True, "count": len(items)}


class ContactIn(BaseModel):
    account_id: int | None = None
    external_id: str = Field(default="", max_length=100)
    name: str = Field(min_length=1, max_length=150)
    phone: str = Field(default="", max_length=30)
    tags: str = Field(default="", max_length=300)
    consent_status: str = Field(default="unknown", pattern="^(unknown|granted|revoked)$")


@app.get("/api/contacts")
def contacts() -> list[dict[str, Any]]:
    return db.rows("SELECT * FROM contacts ORDER BY id DESC LIMIT 5000")


@app.post("/api/contacts")
def create_contact(payload: ContactIn) -> dict[str, Any]:
    contact_id = db.execute(
        """
        INSERT INTO contacts(account_id, external_id, name, phone, source, tags, consent_status)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)
        """,
        (
            payload.account_id,
            payload.external_id.strip() or None,
            payload.name.strip(),
            payload.phone.strip(),
            payload.tags.strip(),
            payload.consent_status,
        ),
    )
    db.audit("contact.created", {"contact_id": contact_id})
    return {"success": True, "id": contact_id}


@app.post("/api/contacts/import")
async def import_contacts(file: UploadFile) -> dict[str, Any]:
    content = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))
    imported = 0
    with db.connection() as conn:
        for raw in reader:
            name = (raw.get("name") or raw.get("ten") or "").strip()
            if not name:
                continue
            consent = (raw.get("consent_status") or "unknown").strip().lower()
            if consent not in {"unknown", "granted", "revoked"}:
                consent = "unknown"
            conn.execute(
                """
                INSERT INTO contacts(external_id, name, phone, source, tags, consent_status)
                VALUES (?, ?, ?, 'csv', ?, ?)
                """,
                (
                    (raw.get("external_id") or raw.get("uid") or "").strip() or None,
                    name,
                    (raw.get("phone") or raw.get("sdt") or "").strip(),
                    (raw.get("tags") or "").strip(),
                    consent,
                ),
            )
            imported += 1
    db.audit("contacts.imported", {"count": imported})
    return {"success": True, "count": imported}


@app.get("/api/contacts/export")
def export_contacts() -> StreamingResponse:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["name", "phone", "external_id", "tags", "consent_status", "source"],
    )
    writer.writeheader()
    for item in db.rows("SELECT * FROM contacts ORDER BY id"):
        writer.writerow({key: item.get(key, "") for key in writer.fieldnames})
    return StreamingResponse(
        iter([output.getvalue().encode("utf-8-sig")]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="akaflow-contacts.csv"'},
    )


class CampaignIn(BaseModel):
    account_id: int
    name: str = Field(min_length=1, max_length=150)
    message: str = Field(min_length=1, max_length=2000)
    delay_seconds: int = Field(default=8, ge=5, le=300)
    dry_run: bool = True
    contact_ids: list[int] = Field(min_length=1, max_length=100)


@app.get("/api/campaigns")
def campaigns() -> list[dict[str, Any]]:
    return db.rows("SELECT * FROM campaigns ORDER BY id DESC")


@app.post("/api/campaigns")
def create_campaign(payload: CampaignIn) -> dict[str, Any]:
    placeholders = ",".join("?" for _ in payload.contact_ids)
    eligible = db.rows(
        f"""SELECT id FROM contacts
        WHERE id IN ({placeholders})
          AND consent_status = 'granted'
          AND external_id IS NOT NULL
          AND external_id != ''""",
        tuple(payload.contact_ids),
    )
    if not eligible:
        raise HTTPException(400, "Không có liên hệ đã đồng ý và có Zalo UID")
    campaign_id = db.execute(
        """
        INSERT INTO campaigns(account_id, name, message, delay_seconds, dry_run, total)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            payload.account_id,
            payload.name.strip(),
            payload.message.strip(),
            payload.delay_seconds,
            int(payload.dry_run),
            len(eligible),
        ),
    )
    with db.connection() as conn:
        conn.executemany(
            "INSERT INTO campaign_targets(campaign_id, contact_id) VALUES (?, ?)",
            [(campaign_id, item["id"]) for item in eligible],
        )
    db.audit(
        "campaign.created",
        {"campaign_id": campaign_id, "total": len(eligible), "dry_run": payload.dry_run},
    )
    return {"success": True, "id": campaign_id, "eligible": len(eligible)}


async def run_campaign(campaign_id: int) -> None:
    campaign = db.row("SELECT * FROM campaigns WHERE id = ?", (campaign_id,))
    if not campaign:
        return
    db.execute("UPDATE campaigns SET status = 'running' WHERE id = ?", (campaign_id,))
    targets = db.rows(
        """
        SELECT ct.contact_id, c.external_id, c.name, c.consent_status
        FROM campaign_targets ct JOIN contacts c ON c.id = ct.contact_id
        WHERE ct.campaign_id = ? AND ct.status = 'queued'
        ORDER BY ct.contact_id LIMIT 100
        """,
        (campaign_id,),
    )
    for target in targets:
        if target["consent_status"] != "granted":
            result = {"success": False, "error": "consent revoked"}
        elif campaign["dry_run"]:
            result = {"success": True, "preview": True}
        else:
            try:
                result = await zalo.send_message(
                    campaign["account_id"],
                    target["external_id"],
                    campaign["message"].replace("[name]", target["name"]),
                )
            except Exception as exc:
                result = {"success": False, "error": str(exc)}
        ok = bool(result.get("success"))
        db.execute(
            "UPDATE campaign_targets SET status = ?, detail = ? WHERE campaign_id = ? AND contact_id = ?",
            ("sent" if ok else "failed", str(result)[:500], campaign_id, target["contact_id"]),
        )
        db.execute(
            f"UPDATE campaigns SET {'sent' if ok else 'failed'} = {'sent' if ok else 'failed'} + 1 WHERE id = ?",
            (campaign_id,),
        )
        if not campaign["dry_run"]:
            await asyncio.sleep(campaign["delay_seconds"])
    db.execute("UPDATE campaigns SET status = 'completed' WHERE id = ?", (campaign_id,))
    db.audit("campaign.completed", {"campaign_id": campaign_id})


@app.post("/api/campaigns/{campaign_id}/start")
def start_campaign(campaign_id: int, background: BackgroundTasks) -> dict[str, Any]:
    campaign = db.row("SELECT * FROM campaigns WHERE id = ?", (campaign_id,))
    if not campaign:
        raise HTTPException(404, "Không tìm thấy chiến dịch")
    if campaign["status"] not in {"draft", "completed"}:
        raise HTTPException(409, "Chiến dịch đang chạy hoặc không thể khởi động")
    background.add_task(run_campaign, campaign_id)
    return {"success": True, "dry_run": bool(campaign["dry_run"])}


@app.get("/api/audit")
def audit_log() -> list[dict[str, Any]]:
    return db.rows("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200")
