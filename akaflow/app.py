from __future__ import annotations

import asyncio
import csv
import io
import json
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

import database as db
from connector import zalo
from salework_connector import SaleworkError, salework


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


class SaleworkConfigIn(BaseModel):
    client_id: str = Field(min_length=1, max_length=200)
    token: str = Field(default="", max_length=2000)
    salework_account_id: str = Field(pattern=r"^\d{5,30}$")
    enabled: bool = True


class SaleworkProbeIn(BaseModel):
    group_id: str = Field(pattern=r"^\d{5,30}$")


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


def salework_config(account_id: int, *, with_token: bool = False) -> dict[str, Any] | None:
    config = db.row(
        "SELECT * FROM salework_integrations WHERE account_id = ?",
        (account_id,),
    )
    if not config:
        return None
    config["enabled"] = bool(config.get("enabled"))
    config["token_set"] = bool(config.get("token"))
    if not with_token:
        config.pop("token", None)
        config.pop("webhook_secret", None)
    return config


@app.get("/api/accounts/{account_id}/salework")
def get_salework_config(account_id: int) -> dict[str, Any]:
    if not db.row("SELECT id FROM accounts WHERE id = ?", (account_id,)):
        raise HTTPException(404, "Không tìm thấy tài khoản")
    private_config = salework_config(account_id, with_token=True)
    if not private_config:
        return {"configured": False, "enabled": False, "token_set": False}
    config = dict(private_config)
    config.pop("token", None)
    config.pop("webhook_secret", None)
    config["token_set"] = bool(private_config.get("token"))
    return {
        "configured": True,
        **config,
        "webhook_path": (
            f"/api/integrations/salework/webhook/{account_id}/"
            f"{private_config['webhook_secret']}"
        ),
    }


@app.put("/api/accounts/{account_id}/salework")
def save_salework_config(account_id: int, payload: SaleworkConfigIn) -> dict[str, Any]:
    if not db.row("SELECT id FROM accounts WHERE id = ?", (account_id,)):
        raise HTTPException(404, "Không tìm thấy tài khoản")
    existing = salework_config(account_id, with_token=True)
    token = payload.token.strip() or str((existing or {}).get("token") or "")
    if not token:
        raise HTTPException(400, "Cần nhập token Salework lần đầu")
    webhook_secret = str((existing or {}).get("webhook_secret") or "")
    if not webhook_secret:
        webhook_secret = secrets.token_urlsafe(32)
    with db.connection() as conn:
        conn.execute(
            """
            INSERT INTO salework_integrations(
                account_id, client_id, token, salework_account_id,
                webhook_secret, enabled, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(account_id) DO UPDATE SET
                client_id = excluded.client_id,
                token = excluded.token,
                salework_account_id = excluded.salework_account_id,
                enabled = excluded.enabled,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                account_id,
                payload.client_id.strip(),
                token,
                payload.salework_account_id.strip(),
                webhook_secret,
                int(payload.enabled),
            ),
        )
    db.audit(
        "salework.config_saved",
        {
            "account_id": account_id,
            "salework_account_id": payload.salework_account_id.strip(),
            "enabled": payload.enabled,
        },
    )
    return get_salework_config(account_id)


@app.post("/api/accounts/{account_id}/salework/test")
async def test_salework_config(
    account_id: int, payload: SaleworkProbeIn
) -> dict[str, Any]:
    config = salework_config(account_id, with_token=True)
    if not config or not config.get("enabled"):
        raise HTTPException(400, "Salework chưa được cấu hình hoặc đang tắt")
    try:
        response = await salework.group_info(
            str(config["client_id"]),
            str(config["token"]),
            str(config["salework_account_id"]),
            payload.group_id,
        )
    except SaleworkError as exc:
        raise HTTPException(502, str(exc)) from exc
    group_map = response.get("gridInfoMap") or {}
    group = group_map.get(payload.group_id) if isinstance(group_map, dict) else None
    if not isinstance(group, dict):
        raise HTTPException(404, "Salework không trả thông tin nhóm này")
    return {
        "success": True,
        "group_name": group.get("name") or payload.group_id,
        "total_members": int(group.get("totalMember") or 0),
        "member_ids": len(group.get("memberIds") or []),
        "current_mems": len(group.get("currentMems") or []),
        "mem_ver_list": len(group.get("memVerList") or []),
        "lock_view_member": int((group.get("setting") or {}).get("lockViewMember") or 0),
    }


@app.post("/api/integrations/salework/webhook/{account_id}/{webhook_secret}")
async def salework_webhook(
    account_id: int, webhook_secret: str, request: Request
) -> dict[str, Any]:
    content_length = int(request.headers.get("content-length") or 0)
    if content_length > 1_000_000:
        raise HTTPException(413, "Webhook quá lớn")
    config = salework_config(account_id, with_token=True)
    if (
        not config
        or not config.get("enabled")
        or not secrets.compare_digest(
            webhook_secret,
            str(config.get("webhook_secret") or ""),
        )
    ):
        raise HTTPException(404, "Webhook không tồn tại")
    try:
        payload = await request.json()
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "Webhook JSON không hợp lệ") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "Webhook JSON không hợp lệ")
    source_account_id = normalized_uid(payload.get("zaloAccountId"))
    if source_account_id != normalized_uid(config.get("salework_account_id")):
        raise HTTPException(403, "Webhook không thuộc tài khoản đã cấu hình")

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    accepted = 0

    def observe(group_id: Any, uid: Any, source: str, details: dict[str, Any] | None = None) -> None:
        nonlocal accepted
        if db.observe_member(
            {
                "account_id": account_id,
                "group_id": group_id,
                "uid": uid,
                "display_name": (details or {}).get("display_name") or "",
                "avatar": (details or {}).get("avatar") or "",
                "source": source,
            }
        ):
            accepted += 1

    for message in data.get("groupMsgs") or []:
        if not isinstance(message, dict):
            continue
        group_id = message.get("idTo")
        observe(
            group_id,
            message.get("uidFrom"),
            "salework:message_sender",
            {"display_name": message.get("dName")},
        )
        for mention in message.get("mentions") or []:
            if isinstance(mention, dict):
                observe(group_id, mention.get("uid"), "salework:mention")
        quote = message.get("quote")
        if isinstance(quote, dict):
            observe(
                group_id,
                quote.get("ownerId"),
                "salework:quote_author",
                {"display_name": quote.get("fromD")},
            )

    for reaction in data.get("reactGroups") or []:
        if not isinstance(reaction, dict):
            continue
        observe(
            reaction.get("idTo") or reaction.get("groupId"),
            reaction.get("uidFrom") or reaction.get("actorId"),
            "salework:reaction",
            {"display_name": reaction.get("dName")},
        )

    for control in data.get("controls") or []:
        if not isinstance(control, dict):
            continue
        content = control.get("content") if isinstance(control.get("content"), dict) else {}
        raw_control_data = content.get("data")
        if isinstance(raw_control_data, str):
            try:
                control_data = json.loads(raw_control_data)
            except (TypeError, ValueError, json.JSONDecodeError):
                control_data = {}
        elif isinstance(raw_control_data, dict):
            control_data = raw_control_data
        else:
            control_data = {}
        group_id = control_data.get("groupId")
        action = str(control_data.get("act") or content.get("act") or "group_event")[:40]
        observe(group_id, control_data.get("sourceId"), f"salework:group:{action}")
        observe(group_id, control_data.get("creatorId"), f"salework:group:{action}")
        for member in control_data.get("updateMembers") or []:
            if isinstance(member, dict):
                observe(
                    group_id,
                    member.get("id") or member.get("uid"),
                    f"salework:group:{action}",
                    {
                        "display_name": member.get("dName"),
                        "avatar": member.get("avatar"),
                    },
                )

    db.audit(
        "salework.webhook_received",
        {"account_id": account_id, "accepted": accepted},
    )
    return {"success": True, "accepted": accepted}


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
    provider_config = salework_config(account_id)
    result["salework"] = {
        "configured": bool(provider_config),
        "enabled": bool((provider_config or {}).get("enabled")),
    }
    return result


def normalized_uid(value: Any) -> str:
    uid = str(value or "").split("_")[0].strip()
    return uid if uid.isdigit() else ""


async def salework_group_snapshot(account_id: int, group_id: str) -> dict[str, Any] | None:
    config = salework_config(account_id, with_token=True)
    if not config or not config.get("enabled"):
        return None
    try:
        response = await salework.group_info(
            str(config["client_id"]),
            str(config["token"]),
            str(config["salework_account_id"]),
            group_id,
        )
        group_map = response.get("gridInfoMap") or {}
        group = group_map.get(group_id) if isinstance(group_map, dict) else None
        if not isinstance(group, dict):
            return {
                "items": [],
                "complete": False,
                "diagnostics": {"status": "missing", "message": "Không có metadata nhóm"},
            }

        setting = group.get("setting") if isinstance(group.get("setting"), dict) else {}
        hidden = int(setting.get("lockViewMember") or 0) == 1
        creator_id = normalized_uid(group.get("creatorId"))
        admin_ids = {
            normalized_uid(value)
            for value in (group.get("adminIds") or [])
            if normalized_uid(value)
        }
        salework_account_id = normalized_uid(config.get("salework_account_id"))
        authorized_roster = bool(
            salework_account_id
            and (salework_account_id == creator_id or salework_account_id in admin_ids)
        )

        embedded_profiles: dict[str, dict[str, Any]] = {}
        for member in group.get("currentMems") or []:
            if not isinstance(member, dict):
                continue
            uid = normalized_uid(member.get("id"))
            if uid:
                embedded_profiles[uid] = member

        member_ids = [
            normalized_uid(value) for value in (group.get("memberIds") or [])
        ]
        member_ids = [value for value in member_ids if value]
        mem_ver_ids: list[str] = []
        if not hidden or authorized_roster:
            mem_ver_ids = [
                normalized_uid(value) for value in (group.get("memVerList") or [])
            ]
            mem_ver_ids = [value for value in mem_ver_ids if value]

        uids = list(
            dict.fromkeys(
                [creator_id, *admin_ids, *member_ids, *embedded_profiles.keys(), *mem_ver_ids]
            )
        )
        uids = [value for value in uids if value]
        profiles = dict(embedded_profiles)
        if uids:
            profiles.update(
                await salework.member_profiles(
                    str(config["client_id"]),
                    str(config["token"]),
                    str(config["salework_account_id"]),
                    uids,
                )
            )

        items: list[dict[str, Any]] = []
        for uid in uids:
            profile = profiles.get(uid) or {}
            role = "Thành viên"
            if uid == creator_id:
                role = "Trưởng nhóm"
            elif uid in admin_ids:
                role = "Phó nhóm"
            items.append(
                {
                    "id": uid,
                    "uid": uid,
                    "name": str(
                        profile.get("displayName")
                        or profile.get("dName")
                        or profile.get("zaloName")
                        or f"Người dùng {uid}"
                    ).strip(),
                    "zalo_name": str(profile.get("zaloName") or "").strip(),
                    "avatar": str(profile.get("avatar") or ""),
                    "role": role,
                    "is_admin": uid == creator_id or uid in admin_ids,
                    "type": "member",
                    "source": "Salework",
                }
            )

        total = int(group.get("totalMember") or 0)
        return {
            "items": items,
            "complete": bool(total and len(uids) >= total),
            "diagnostics": {
                "status": "ok",
                "total_members": total,
                "member_ids": len(group.get("memberIds") or []),
                "current_mems": len(group.get("currentMems") or []),
                "mem_ver_list": len(group.get("memVerList") or []),
                "used_uids": len(uids),
                "hidden": hidden,
                "authorized_roster": authorized_roster,
                "mem_ver_used": bool(mem_ver_ids),
            },
        }
    except SaleworkError as exc:
        return {
            "items": [],
            "complete": False,
            "diagnostics": {"status": "error", "message": str(exc)},
        }


@app.get("/api/accounts/{account_id}/groups/{group_id}/members")
async def group_members(account_id: int, group_id: str) -> dict[str, Any]:
    await asyncio.to_thread(drain_observation_queue)

    # Find observed members that need profile resolution (e.g. captured from typing/seen/delivered)
    pre_observed = db.observed_members(account_id, group_id)
    need_profiles = [
        str(m["uid"]) for m in pre_observed
        if not m.get("display_name") or str(m.get("display_name", "")).startswith("Người dùng ")
    ]

    zalo_task = asyncio.create_task(
        zalo.group_members(account_id, group_id, extra_uids=need_profiles[:100])
    )
    salework_task = asyncio.create_task(salework_group_snapshot(account_id, group_id))
    result, salework_result = await asyncio.gather(zalo_task, salework_task)

    for item in result.get("items", []):
        item.setdefault("source", "Zalo trực tiếp")
    if salework_result:
        items_by_uid = {
            str(item.get("uid") or item.get("id") or ""): item
            for item in result.get("items", [])
        }
        added = 0
        for sw_item in salework_result.get("items", []):
            uid = str(sw_item.get("uid") or "")
            if not uid:
                continue
            existing = items_by_uid.get(uid)
            if existing:
                existing["source"] = "Zalo + Salework"
                if str(existing.get("name") or "").startswith("Người dùng "):
                    existing["name"] = sw_item.get("name") or existing["name"]
                if not existing.get("avatar") and sw_item.get("avatar"):
                    existing["avatar"] = sw_item["avatar"]
            else:
                result.setdefault("items", []).append(sw_item)
                items_by_uid[uid] = sw_item
                added += 1
        result["salework_added"] = added
        result["provider_diagnostics"] = {
            "salework": salework_result.get("diagnostics") or {}
        }
        result["providers"] = ["zca-js", "salework"]
        if salework_result.get("complete"):
            result["complete"] = True
        diagnostics = salework_result.get("diagnostics") or {}
        if diagnostics.get("status") == "ok":
            result["message"] = (
                f"{result.get('message') or ''} Salework bổ sung {added} UID; "
                f"nguồn này thấy {diagnostics.get('used_uids', 0)}/"
                f"{diagnostics.get('total_members', 0)} thành viên."
            ).strip()
    else:
        result["providers"] = ["zca-js"]

    total_members = int(result.get("total_members") or 0)
    if (
        result.get("member_source") == "enabled_group_link"
        and total_members > len(result.get("items", []))
    ):
        result["complete"] = False
        result["access_limited"] = True
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
