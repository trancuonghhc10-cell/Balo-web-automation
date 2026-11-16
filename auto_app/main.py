import os
import json
import asyncio
from typing import List, Optional
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, BackgroundTasks, Form, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import io

from core.database import (
    init_db, list_accounts, get_account, create_account, delete_account, update_account_status,
    list_proxies, get_proxy, create_proxy, delete_proxy,
    list_campaigns, get_campaign, create_campaign, update_campaign_progress,
    get_recent_logs, add_log,
    list_contacts, bulk_add_contacts, delete_contact, clear_contacts, count_contacts, get_contact_groups,
    list_auto_replies, create_auto_reply, delete_auto_reply, toggle_auto_reply
)
from core.browser_manager import browser_manager
from core.zalo_api_bridge import zalo_bridge
from core.scenarios import (
    run_open_login, test_proxy, run_campaign_task, sync_zalo_contacts,
    scan_zalo_data, scan_zalo_data_stream, check_phone_numbers, check_phone_numbers_stream
)

app = FastAPI(title="Ubuntu Marketing Automation Core")

zalo_service_process = None

# Mount templates & static
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

# Realtime WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except:
                self.disconnect(connection)

ws_manager = ConnectionManager()

# Hook add_log to broadcast
original_add_log = add_log
def broadcast_add_log(message: str, level: str = 'INFO', campaign_id: int = None, account_id: int = None):
    original_add_log(message, level, campaign_id, account_id)
    # Broadcast to WS clients in event loop
    try:
        loop = asyncio.get_running_loop()
        log_entry = {
            "time": asyncio.get_event_loop().time(),
            "level": level,
            "message": message,
            "account_id": account_id,
            "campaign_id": campaign_id
        }
        loop.create_task(ws_manager.broadcast({"type": "log", "data": log_entry}))
    except RuntimeError:
        pass

# Monkey-patch add_log with broadcast
import core.database
core.database.add_log = broadcast_add_log
import core.scenarios
core.scenarios.add_log = broadcast_add_log
import core.browser_manager
core.browser_manager.add_log = broadcast_add_log

@app.on_event("startup")
async def startup_event():
    global zalo_service_process
    init_db()
    
    # Auto-ensure Zalo API service (zca-js) is running on port 8001
    alive = await zalo_bridge.is_service_alive()
    if not alive:
        import subprocess
        env = os.environ.copy()
        env["PATH"] = f"/home/pccuong/.local/bin:{env.get('PATH', '')}"
        service_script = os.path.join(BASE_DIR, "core", "zalo_service.mjs")
        zalo_service_process = subprocess.Popen(
            ["node", service_script],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        broadcast_add_log("Đã khởi chạy Zalo API Microservice (zca-js) trên cổng 8001", "SUCCESS")
    else:
        broadcast_add_log("Zalo API Microservice (zca-js) đang hoạt động trên cổng 8001", "SUCCESS")

    broadcast_add_log("Hệ thống Ubuntu Automation Server đã khởi động thành công trên cổng 8000", "SUCCESS")

@app.on_event("shutdown")
async def shutdown_event():
    global zalo_service_process
    if zalo_service_process:
        zalo_service_process.terminate()
    await browser_manager.shutdown()

# --- Page Route ---
@app.get("/", response_class=HTMLResponse)
async def dashboard_page(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

# --- WebSocket for Realtime Logs & Events ---
@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            # Keep-alive
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

# --- REST APIs ---
@app.get("/api/stats")
async def get_stats():
    accounts = list_accounts()
    proxies = list_proxies()
    campaigns = list_campaigns()
    running_accs = sum(1 for a in accounts if a["status"] == "running")
    active_proxies = sum(1 for p in proxies if p["status"] == "active")
    running_camps = sum(1 for c in campaigns if c["status"] == "running")
    return {
        "total_accounts": len(accounts),
        "running_accounts": running_accs,
        "total_proxies": len(proxies),
        "active_proxies": active_proxies,
        "total_campaigns": len(campaigns),
        "running_campaigns": running_camps,
        "total_contacts": count_contacts(),
        "contact_groups": get_contact_groups(),
        "recent_logs": get_recent_logs(30)
    }

# Accounts
class AccountCreate(BaseModel):
    name: str
    platform: str = "zalo"
    phone: Optional[str] = None
    proxy_id: Optional[int] = None
    notes: Optional[str] = None

@app.get("/api/accounts")
async def api_list_accounts():
    accounts = list_accounts()
    for acc in accounts:
        acc["is_running"] = browser_manager.is_browser_running(acc["id"])
        sess = await zalo_bridge.get_session_status(acc["id"])
        acc["api_connected"] = sess.get("active", False)
        acc["has_saved_session"] = sess.get("has_saved_session", False)
        acc["zalo_uid"] = sess.get("own_id")
    return accounts

@app.post("/api/accounts")
async def api_create_account(acc: AccountCreate):
    new_id = create_account(acc.name, acc.platform, acc.phone, acc.proxy_id, acc.notes)
    broadcast_add_log(f"Đã tạo mới tài khoản '{acc.name}' (ID: {new_id})", "SUCCESS", account_id=new_id)
    return {"success": True, "id": new_id}

@app.delete("/api/accounts/{account_id}")
async def api_delete_account(account_id: int):
    await browser_manager.close_account_browser(account_id)
    delete_account(account_id)
    broadcast_add_log(f"Đã xóa tài khoản ID #{account_id}", "INFO")
    return {"success": True}

@app.post("/api/accounts/{account_id}/open")
async def api_open_account_browser(account_id: int, background_tasks: BackgroundTasks):
    background_tasks.add_task(run_open_login, account_id)
    return {"success": True, "message": "Đang mở cửa sổ trình duyệt..."}

@app.post("/api/accounts/{account_id}/close")
async def api_close_account_browser(account_id: int):
    await browser_manager.close_account_browser(account_id)
    return {"success": True, "message": "Đã đóng trình duyệt"}

# --- ZALO API (zca-js) QR LOGIN & SESSION CONTROLS ---
@app.post("/api/accounts/{account_id}/qr-login/start")
async def api_account_qr_start(account_id: int):
    res = await zalo_bridge.start_qr_login(account_id)
    return res

@app.get("/api/accounts/{account_id}/qr-login/status")
async def api_account_qr_status(account_id: int):
    res = await zalo_bridge.poll_qr_login(account_id)
    return res

@app.post("/api/accounts/{account_id}/qr-login/abort")
async def api_account_qr_abort(account_id: int):
    res = await zalo_bridge.abort_qr_login(account_id)
    return res

@app.get("/api/accounts/{account_id}/session-status")
async def api_account_session_status(account_id: int):
    res = await zalo_bridge.get_session_status(account_id)
    return res

@app.post("/api/accounts/{account_id}/eval")
async def api_eval(account_id: int, req: Request):
    data = await req.json()
    script = data.get("script")
    page = browser_manager.active_pages.get(account_id)
    if not page:
        page = await browser_manager.launch_account_browser(account_id, headless=True, target_url="https://chat.zalo.me")
        await asyncio.sleep(2)
    try:
        res = await page.evaluate(script)
        return {"success": True, "result": res}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/api/accounts/{account_id}/sync-session-from-browser")
async def api_sync_session_from_browser(account_id: int):
    session_data = await browser_manager.extract_zalo_session(account_id)
    if not session_data or not session_data.get("cookies"):
        return {"success": False, "error": "Trình duyệt chưa mở hoặc chưa có cookie"}
    res = await zalo_bridge.save_session(
        account_id=account_id,
        cookie=session_data["cookies"],
        imei=session_data.get("imei"),
        user_agent=session_data.get("userAgent")
    )
    return res

@app.post("/api/accounts/{account_id}/sync")
async def api_sync_account(account_id: int, background_tasks: BackgroundTasks):
    background_tasks.add_task(sync_zalo_contacts, account_id)
    return {"success": True, "message": "Đang bắt đầu quét đồng bộ danh bạ..."}

# --- Auto-Reply / Chatbot Models & Endpoints ---
class AutoReplyCreate(BaseModel):
    account_id: int
    keyword: str
    reply_message: str
    match_type: str = "contains"

class AutoReplyToggle(BaseModel):
    is_active: int

class ListenerToggleRequest(BaseModel):
    enable: bool

class QuickSendRequest(BaseModel):
    to_id: str
    message: str
    is_group: bool = False
    attachments: Optional[List[str]] = None

class QuickFriendRequest(BaseModel):
    user_id: str
    message: Optional[str] = "Xin chào!"

class AddGroupMembersRequest(BaseModel):
    groupId: str
    userIds: List[str]

@app.get("/api/auto-replies")
async def api_list_auto_replies(account_id: Optional[int] = None):
    return list_auto_replies(account_id)

@app.post("/api/auto-replies")
async def api_create_auto_reply(r: AutoReplyCreate):
    new_id = create_auto_reply(r.account_id, r.keyword, r.reply_message, r.match_type)
    rules = list_auto_replies(r.account_id)
    await zalo_bridge.toggle_listener(r.account_id, True, rules)
    broadcast_add_log(f"Đã thêm quy tắc tự động trả lời cho từ khóa '{r.keyword}' (Tài khoản #{r.account_id})", "SUCCESS", account_id=r.account_id)
    return {"success": True, "id": new_id}

@app.delete("/api/auto-replies/{rule_id}")
async def api_delete_auto_reply(rule_id: int):
    delete_auto_reply(rule_id)
    return {"success": True}

@app.post("/api/auto-replies/{rule_id}/toggle")
async def api_toggle_auto_reply(rule_id: int, req: AutoReplyToggle):
    toggle_auto_reply(rule_id, req.is_active)
    return {"success": True}

@app.post("/api/accounts/{account_id}/listener")
async def api_toggle_account_listener(account_id: int, req: ListenerToggleRequest):
    rules = list_auto_replies(account_id)
    res = await zalo_bridge.toggle_listener(account_id, req.enable, rules)
    state_str = "bật" if req.enable else "tắt"
    broadcast_add_log(f"Đã {state_str} dịch vụ Lắng nghe & Tự động phản hồi cho tài khoản #{account_id}", "SUCCESS", account_id=account_id)
    return res

@app.post("/api/zalo-webhook/message")
async def api_zalo_webhook_message(req: Request):
    data = await req.json()
    acc_id = data.get("account_id")
    from_uid = data.get("from_uid")
    content = data.get("content")
    broadcast_add_log(f"Tin nhắn Zalo mới từ {from_uid}: {content}", "INFO", account_id=acc_id)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(ws_manager.broadcast({"type": "incoming_chat", "data": data}))
    except:
        pass
    return {"status": "ok"}

@app.post("/api/accounts/{account_id}/quick-send")
async def api_quick_send(account_id: int, req: QuickSendRequest):
    res = await zalo_bridge.send_message(account_id, req.to_id, req.message, req.is_group, req.attachments)
    if res.get("success"):
        broadcast_add_log(f"Đã gửi tin nhắn tới {req.to_id}!", "SUCCESS", account_id=account_id)
    return res

@app.post("/api/accounts/{account_id}/quick-friend")
async def api_quick_friend(account_id: int, req: QuickFriendRequest):
    res = await zalo_bridge.send_friend_request(account_id, req.user_id, req.message or "Xin chào!")
    if res.get("success"):
        broadcast_add_log(f"Đã gửi lời mời kết bạn tới {req.user_id}!", "SUCCESS", account_id=account_id)
    return res

@app.post("/api/accounts/{account_id}/add-group-members")
async def api_add_group_members(account_id: int, req: AddGroupMembersRequest):
    res = await zalo_bridge.add_user_to_group(account_id, req.groupId, req.userIds)
    if res.get("success"):
        broadcast_add_log(f"Đã mời {len(req.userIds)} thành viên vào nhóm {req.groupId}!", "SUCCESS", account_id=account_id)
    return res

# --- Data Scan & Phone Check (Compatible with akaAgent & Dashboard) ---
class DataScanRequest(BaseModel):
    action: str = "zalo_groups"
    group_name: Optional[str] = None
    zaloGroupId: Optional[str] = None
    mode: Optional[str] = None

class PhoneCheckRequest(BaseModel):
    phoneList: List[str]

class ImportScannedRequest(BaseModel):
    group_name: str = "Zalo Quét Tự Động"
    items: List[dict]

@app.post("/api/accounts/{account_id}/data-scan")
async def api_data_scan(account_id: int, req: DataScanRequest):
    options = {"group_name": req.group_name, "zaloGroupId": req.zaloGroupId, "mode": req.mode}
    res = await scan_zalo_data(account_id, req.action, options)
    return res

@app.post("/api/aka-agent/control/v1/accounts/zalo/{account_id}/data-scan/stream")
async def api_aka_agent_data_scan_stream(account_id: int, req: DataScanRequest):
    options = {"group_name": req.group_name, "zaloGroupId": req.zaloGroupId, "mode": req.mode}
    return StreamingResponse(
        scan_zalo_data_stream(account_id, req.action, options),
        media_type="application/x-ndjson"
    )

@app.post("/api/accounts/{account_id}/phone-check")
async def api_phone_check(account_id: int, req: PhoneCheckRequest):
    res = await check_phone_numbers(account_id, req.phoneList)
    return res

@app.post("/api/aka-agent/control/v1/accounts/zalo/{account_id}/phone-check/stream")
async def api_aka_agent_phone_check_stream(account_id: int, req: PhoneCheckRequest):
    return StreamingResponse(
        check_phone_numbers_stream(account_id, req.phoneList),
        media_type="application/x-ndjson"
    )

@app.post("/api/contacts/import-scanned")
async def api_import_scanned_contacts(req: ImportScannedRequest):
    contacts = []
    for item in req.items:
        contacts.append({
            "name": item.get("name", "Liên hệ"),
            "phone": item.get("uid") or item.get("phone") or item.get("name", ""),
            "group_name": req.group_name,
            "tag": item.get("role") or item.get("type") or "Quét tự động"
        })
    count = bulk_add_contacts(contacts)
    broadcast_add_log(f"Đã lưu thành công {count} liên hệ vào nhóm '{req.group_name}'!", "SUCCESS")
    return {"success": True, "count": count}

# Contacts / Customers
class ContactCreate(BaseModel):
    name: Optional[str] = None
    phone: str
    group_name: Optional[str] = "Mặc định"
    tag: Optional[str] = None

@app.get("/api/contacts")
async def api_list_contacts(group_name: Optional[str] = None):
    return list_contacts(group_name)

@app.post("/api/contacts")
async def api_create_contact(c: ContactCreate):
    count = bulk_add_contacts([c.dict()])
    return {"success": True, "count": count}

@app.post("/api/contacts/import-excel")
async def api_import_excel(file: UploadFile = File(...), group_name: str = Form("Mặc định")):
    import openpyxl
    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    sheet = wb.active

    contacts = []
    # Try to detect columns from first row
    first_row = [str(cell.value or "").strip().lower() for cell in next(sheet.iter_rows(max_row=1))]
    phone_idx = 0
    name_idx = 1 if len(first_row) > 1 else None

    for idx, col_name in enumerate(first_row):
        if any(k in col_name for k in ["phone", "sđt", "sdt", "điện thoại"]):
            phone_idx = idx
        elif any(k in col_name for k in ["name", "tên", "họ tên", "khách hàng"]):
            name_idx = idx

    # Read data rows
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if not row or len(row) <= phone_idx or not row[phone_idx]:
            continue
        phone_val = str(row[phone_idx]).strip()
        # Clean float if excel read as 912345678.0
        if phone_val.endswith(".0"):
            phone_val = phone_val[:-2]
        
        name_val = str(row[name_idx]).strip() if name_idx is not None and len(row) > name_idx and row[name_idx] else f"Khách {phone_val}"
        contacts.append({
            "phone": phone_val,
            "name": name_val,
            "group_name": group_name
        })

    added_count = bulk_add_contacts(contacts)
    broadcast_add_log(f"Đã nhập thành công {added_count} số điện thoại vào nhóm '{group_name}' từ tệp Excel {file.filename}", "SUCCESS")
    return {"success": True, "added": added_count}

@app.delete("/api/contacts/{contact_id}")
async def api_delete_contact(contact_id: int):
    delete_contact(contact_id)
    return {"success": True}

@app.delete("/api/contacts")
async def api_clear_contacts(group_name: Optional[str] = None):
    clear_contacts(group_name)
    broadcast_add_log(f"Đã xóa danh sách khách hàng ({group_name or 'Tất cả'})", "INFO")
    return {"success": True}

# Proxies
class ProxyCreate(BaseModel):
    name: str
    server: str
    username: Optional[str] = None
    password: Optional[str] = None

@app.get("/api/proxies")
async def api_list_proxies():
    return list_proxies()

@app.post("/api/proxies")
async def api_create_proxy(p: ProxyCreate):
    new_id = create_proxy(p.name, p.server, p.username, p.password)
    broadcast_add_log(f"Đã thêm proxy mới '{p.name}' ({p.server})", "INFO")
    return {"success": True, "id": new_id}

@app.delete("/api/proxies/{proxy_id}")
async def api_delete_proxy(proxy_id: int):
    delete_proxy(proxy_id)
    return {"success": True}

@app.post("/api/proxies/{proxy_id}/test")
async def api_test_proxy(proxy_id: int):
    res = await test_proxy(proxy_id)
    return res

# Campaigns
class CampaignCreate(BaseModel):
    name: str
    platform: str = "zalo"
    action_type: str = "send_message"
    account_ids: List[int]
    targets: List[str] = []
    message: str = "Xin chào bạn!"
    delay_min: int = 3
    delay_max: int = 7

@app.get("/api/campaigns")
async def api_list_campaigns():
    return list_campaigns()

@app.post("/api/campaigns")
async def api_create_campaign(c: CampaignCreate):
    params = {
        "targets": c.targets,
        "message": c.message,
        "delay_min": c.delay_min,
        "delay_max": c.delay_max
    }
    camp_id = create_campaign(c.name, c.platform, c.action_type, c.account_ids, params)
    broadcast_add_log(f"Đã tạo chiến dịch mới '{c.name}' (Mục tiêu: {len(c.targets)} số)", "SUCCESS", campaign_id=camp_id)
    return {"success": True, "id": camp_id}

@app.post("/api/campaigns/{campaign_id}/start")
async def api_start_campaign(campaign_id: int, background_tasks: BackgroundTasks):
    background_tasks.add_task(run_campaign_task, campaign_id)
    return {"success": True, "message": "Chiến dịch đang bắt đầu chạy ngầm..."}

# Logs
@app.get("/api/logs")
async def api_list_logs():
    return get_recent_logs(100)
