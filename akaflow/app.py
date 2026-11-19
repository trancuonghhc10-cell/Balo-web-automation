from __future__ import annotations

import asyncio
import csv
import io
import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

import database as db
from connector import zalo


BASE_DIR = Path(__file__).resolve().parent
app = FastAPI(title="AkaFlow", docs_url=None, redoc_url=None)
observation_task: asyncio.Task[None] | None = None


def drain_observation_queue() -> int:
    db.DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    queue_path = db.DATA_DIR / "observed-events.ndjson"
    processing_paths = sorted(db.DATA_DIR.glob("observed-events.*.processing"))

    if queue_path.exists() and queue_path.stat().st_size:
        processing_path = db.DATA_DIR / f"observed-events.{time.time_ns()}.processing"
        try:
            queue_path.replace(processing_path)
            processing_paths.append(processing_path)
        except FileNotFoundError:
            pass

    accepted = 0
    for path in processing_paths:
        completed = False
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if isinstance(event, dict) and db.observe_member(event):
                        accepted += 1
            completed = True
        finally:
            if completed:
                path.unlink(missing_ok=True)
    return accepted


async def observation_collector() -> None:
    while True:
        await asyncio.to_thread(drain_observation_queue)
        await asyncio.sleep(2)


@app.on_event("startup")
async def startup() -> None:
    global observation_task
    db.init_db()
    await asyncio.to_thread(drain_observation_queue)
    observation_task = asyncio.create_task(observation_collector())


@app.on_event("shutdown")
async def shutdown() -> None:
    global observation_task
    if observation_task:
        observation_task.cancel()
        try:
            await observation_task
        except asyncio.CancelledError:
            pass
        observation_task = None


@app.get("/", response_class=HTMLResponse)
def dashboard() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    await asyncio.to_thread(drain_observation_queue)
    connector = await zalo.health()
    return {
        "status": "ok",
        "connector": connector,
        "observations": db.observation_summary(),
    }


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=500)


class GroupLinkIn(BaseModel):
    link: str = Field(min_length=20, max_length=300)


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


class FacebookAccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=500)


class FacebookOpenIn(BaseModel):
    destination: str = Field(default="home", pattern="^(home|suggestions|requests)$")


class FacebookDraftIn(BaseModel):
    account_id: int
    target_type: str = Field(pattern="^(profile|group)$")
    target_url: str = Field(default="", max_length=1000)
    content: str = Field(min_length=1, max_length=20000)


class FacebookDraftStatusIn(BaseModel):
    status: str = Field(pattern="^(draft|published|cancelled)$")


def facebook_url(value: str, *, allow_empty: bool = False) -> str:
    raw = value.strip()
    if not raw and allow_empty:
        return ""
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (
        host == "facebook.com" or host.endswith(".facebook.com")
    ):
        raise HTTPException(400, "Chỉ chấp nhận địa chỉ HTTPS thuộc facebook.com")
    return raw


def open_facebook_browser(account_id: int, url: str) -> None:
    if not db.row("SELECT id FROM facebook_accounts WHERE id = ?", (account_id,)):
        raise HTTPException(404, "Không tìm thấy hồ sơ Facebook")

    chrome = shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    if not chrome:
        raise HTTPException(503, "Máy chưa cài Google Chrome")

    profile_dir = db.DATA_DIR / "facebook_profiles" / f"account_{account_id}"
    profile_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.Popen(
        [
            chrome,
            f"--user-data-dir={profile_dir}",
            "--new-window",
            "--no-first-run",
            "--password-store=basic",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    db.execute(
        "UPDATE facebook_accounts SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ?",
        (account_id,),
    )


@app.get("/api/facebook/accounts")
def facebook_accounts() -> list[dict[str, Any]]:
    return db.rows("SELECT * FROM facebook_accounts ORDER BY id DESC")


@app.post("/api/facebook/accounts")
def create_facebook_account(payload: FacebookAccountIn) -> dict[str, Any]:
    account_id = db.execute(
        "INSERT INTO facebook_accounts(name, notes) VALUES (?, ?)",
        (payload.name.strip(), payload.notes.strip()),
    )
    db.audit("facebook.account_created", {"account_id": account_id})
    return {"success": True, "id": account_id}


@app.post("/api/facebook/accounts/{account_id}/open")
def open_facebook_account(
    account_id: int, payload: FacebookOpenIn
) -> dict[str, Any]:
    destinations = {
        "home": "https://www.facebook.com/",
        "suggestions": "https://www.facebook.com/friends/suggestions",
        "requests": "https://www.facebook.com/friends/requests",
    }
    url = destinations[payload.destination]
    open_facebook_browser(account_id, url)
    db.audit(
        "facebook.browser_opened",
        {"account_id": account_id, "destination": payload.destination},
    )
    return {"success": True, "url": url}


@app.get("/api/facebook/drafts")
def facebook_drafts() -> list[dict[str, Any]]:
    return db.rows(
        """
        SELECT d.*, a.name AS account_name
        FROM facebook_drafts d
        JOIN facebook_accounts a ON a.id = d.account_id
        ORDER BY d.id DESC LIMIT 500
        """
    )


@app.post("/api/facebook/drafts")
def create_facebook_draft(payload: FacebookDraftIn) -> dict[str, Any]:
    if not db.row("SELECT id FROM facebook_accounts WHERE id = ?", (payload.account_id,)):
        raise HTTPException(404, "Không tìm thấy hồ sơ Facebook")
    target_url = facebook_url(
        payload.target_url,
        allow_empty=payload.target_type == "profile",
    )
    if payload.target_type == "group" and "/groups/" not in target_url:
        raise HTTPException(400, "Bài nhóm cần địa chỉ facebook.com/groups/...")

    draft_id = db.execute(
        """
        INSERT INTO facebook_drafts(account_id, target_type, target_url, content)
        VALUES (?, ?, ?, ?)
        """,
        (payload.account_id, payload.target_type, target_url, payload.content.strip()),
    )
    db.audit("facebook.draft_created", {"draft_id": draft_id})
    return {"success": True, "id": draft_id}


@app.post("/api/facebook/drafts/{draft_id}/open")
def open_facebook_draft(draft_id: int) -> dict[str, Any]:
    draft = db.row("SELECT * FROM facebook_drafts WHERE id = ?", (draft_id,))
    if not draft:
        raise HTTPException(404, "Không tìm thấy bản nháp")
    url = draft["target_url"] or "https://www.facebook.com/"
    open_facebook_browser(int(draft["account_id"]), url)
    db.execute(
        """
        UPDATE facebook_drafts
        SET status = 'opened', updated_at = CURRENT_TIMESTAMP WHERE id = ?
        """,
        (draft_id,),
    )
    db.audit("facebook.draft_opened", {"draft_id": draft_id})
    return {"success": True, "url": url, "content": draft["content"]}


@app.post("/api/facebook/drafts/{draft_id}/status")
def update_facebook_draft_status(
    draft_id: int, payload: FacebookDraftStatusIn
) -> dict[str, Any]:
    if not db.row("SELECT id FROM facebook_drafts WHERE id = ?", (draft_id,)):
        raise HTTPException(404, "Không tìm thấy bản nháp")
    db.execute(
        """
        UPDATE facebook_drafts
        SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        """,
        (payload.status, draft_id),
    )
    db.audit(
        "facebook.draft_status_changed",
        {"draft_id": draft_id, "status": payload.status},
    )
    return {"success": True, "status": payload.status}


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
    await asyncio.to_thread(drain_observation_queue)
    result = await zalo.groups(account_id)
    observed_counts = {
        str(item["group_id"]): int(item["count"])
        for item in db.rows(
            """
            SELECT group_id, COUNT(*) AS count FROM observed_members
            WHERE account_id = ? GROUP BY group_id
            """,
            (account_id,),
        )
    }
    for item in result.get("items", []):
        item["observed_count"] = observed_counts.get(str(item.get("id")), 0)
    result["observation_summary"] = db.observation_summary(account_id)
    return result


@app.get("/api/accounts/{account_id}/groups/{group_id}/members")
async def group_members(account_id: int, group_id: str) -> dict[str, Any]:
    await asyncio.to_thread(drain_observation_queue)

    # Find observed members that need profile resolution (e.g. captured from typing/seen/delivered)
    pre_observed = db.observed_members(account_id, group_id)
    need_profiles = [
        str(m["uid"]) for m in pre_observed
        if not m.get("display_name") or str(m.get("display_name", "")).startswith("Người dùng ")
    ]

    result = await zalo.group_members(account_id, group_id, extra_uids=need_profiles[:100])
    if result.get("member_source") in {"public_interactive", "enabled_group_link"}:
        for item in result.get("items", []):
            db.observe_member(
                {
                    "account_id": account_id,
                    "group_id": group_id,
                    "uid": item.get("uid") or item.get("id"),
                    "display_name": item.get("name"),
                    "avatar": item.get("avatar"),
                    "source": (
                        "enabled_group_link"
                        if result.get("member_source") == "enabled_group_link"
                        else f"snapshot:{item.get('role') or 'interaction'}"
                    ),
                }
            )

    # Update any newly resolved profiles into observed_members
    resolved_profiles = result.get("resolved_profiles") or {}
    if resolved_profiles:
        with db.connection() as conn:
            for uid, prof in resolved_profiles.items():
                if isinstance(prof, dict):
                    d_name = prof.get("displayName") or prof.get("zaloName") or ""
                    avatar = prof.get("avatar") or ""
                    if d_name:
                        conn.execute(
                            """
                            UPDATE observed_members
                            SET display_name = ?,
                                avatar = CASE WHEN ? != '' THEN ? ELSE avatar END
                            WHERE account_id = ? AND group_id = ? AND uid = ?
                            """,
                            (d_name, avatar, avatar, account_id, group_id, str(uid)),
                        )

    observed = db.observed_members(account_id, group_id)
    direct_uids = {
        str(item.get("uid") or item.get("id") or "")
        for item in result.get("items", [])
    }
    result["observed_items"] = [
        {
            "uid": item["uid"],
            "name": item["display_name"] or f"Người dùng {item['uid']}",
            "avatar": item["avatar"],
            "sources": item["sources"],
            "first_seen_at": item["first_seen_at"],
            "last_seen_at": item["last_seen_at"],
            "evidence_count": item["evidence_count"],
            "already_in_roster": item["uid"] in direct_uids,
        }
        for item in observed
    ]
    result["observed_count"] = len(observed)
    result["resolved_unique_count"] = len(direct_uids | {item["uid"] for item in observed})
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


@app.post("/api/accounts/{account_id}/group-link/members")
async def group_link_members(account_id: int, payload: GroupLinkIn) -> dict[str, Any]:
    if not db.row("SELECT id FROM accounts WHERE id = ?", (account_id,)):
        raise HTTPException(404, "Không tìm thấy tài khoản")

    result = await zalo.group_link_members(account_id, payload.link.strip())
    if not result.get("success"):
        raise HTTPException(
            int(result.get("status_code") or 400),
            result.get("error") or "Không đọc được link nhóm",
        )

    group_id = str(result.get("group_id") or "").strip()
    if group_id:
        for item in result.get("items", []):
            db.observe_member(
                {
                    "account_id": account_id,
                    "group_id": group_id,
                    "uid": item.get("uid") or item.get("id"),
                    "display_name": item.get("name"),
                    "avatar": item.get("avatar"),
                    "source": "enabled_group_link",
                }
            )
    result["observed_count"] = 0
    result["resolved_unique_count"] = len(result.get("items", []))
    db.audit(
        "group.invite_link_viewed",
        {
            "account_id": account_id,
            "group_id": group_id,
            "count": len(result.get("items", [])),
            "complete": bool(result.get("complete")),
        },
    )
    return result


@app.get("/api/accounts/{account_id}/observations")
async def observations(account_id: int, group_id: str | None = None) -> dict[str, Any]:
    await asyncio.to_thread(drain_observation_queue)
    if group_id:
        items = db.observed_members(account_id, group_id)
    else:
        items = db.rows(
            """
            SELECT account_id, group_id, uid, display_name, avatar,
                   source_types, first_seen_at, last_seen_at,
                   evidence_count, last_event_type
            FROM observed_members WHERE account_id = ?
            ORDER BY last_seen_at DESC LIMIT 5000
            """,
            (account_id,),
        )
    return {
        "success": True,
        "summary": db.observation_summary(account_id),
        "items": items,
    }


@app.post("/api/accounts/{account_id}/groups/{group_id}/import")
async def import_group_members(account_id: int, group_id: str) -> dict[str, Any]:
    result = await group_members(account_id, group_id)
    direct_items = result.get("items", []) if result.get("success") else []
    observed_items = result.get("observed_items", []) if result.get("success") else []
    items_by_uid: dict[str, dict[str, Any]] = {}
    for item in [*direct_items, *observed_items]:
        uid = str(item.get("uid") or item.get("id") or "").strip()
        if uid:
            items_by_uid[uid] = item
    items = list(items_by_uid.values())
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
