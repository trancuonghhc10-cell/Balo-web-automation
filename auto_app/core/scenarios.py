import asyncio
import json
import random
import re
from typing import Dict, Any, List, AsyncGenerator
from core.browser_manager import browser_manager
from core.zalo_api_bridge import zalo_bridge
from core.database import (
    get_account, get_proxy, update_proxy_status, update_account_status,
    update_campaign_progress, add_log, bulk_add_contacts
)

async def run_open_login(account_id: int):
    account = get_account(account_id)
    if not account:
        return

    platform = account["platform"].lower()
    target_url = "https://chat.zalo.me"
    if platform == "facebook":
        target_url = "https://facebook.com"
    elif platform == "shopee":
        target_url = "https://shopee.vn/buyer/login"

    add_log(f"Mở trình duyệt đăng nhập cho {account['name']} ({platform.upper()})...", "INFO", account_id=account_id)
    page = await browser_manager.launch_account_browser(account_id, headless=False, target_url=target_url)
    asyncio.create_task(_monitor_login_success(account_id, page, platform))

async def _monitor_login_success(account_id: int, page, platform: str):
    try:
        for _ in range(60): # Monitor up to 5 minutes
            await asyncio.sleep(5)
            if not browser_manager.is_browser_running(account_id):
                break

            if platform == "zalo":
                has_nav = await page.evaluate("() => !!document.querySelector('#main-tab, .nav__tabs, .chat-box, #contact-search-input')")
                if has_nav:
                    update_account_status(account_id, "logged_in")
                    add_log(f"Tài khoản Zalo '{account_id}' đăng nhập thành công!", "SUCCESS", account_id=account_id)
                    break
            elif platform == "facebook":
                has_feed = await page.evaluate("() => !!document.querySelector('div[role=\"feed\"], div[role=\"navigation\"]')")
                if has_feed:
                    update_account_status(account_id, "logged_in")
                    add_log(f"Tài khoản Facebook '{account_id}' đăng nhập thành công!", "SUCCESS", account_id=account_id)
                    break
    except Exception:
        pass

# --- ZALO DATA SCAN (Pure zca-js High-Speed API, No Browser Conflict) ---
async def scan_zalo_data(account_id: int, action: str = "zalo_groups", options: dict = None) -> Dict[str, Any]:
    options = options or {}
    account = get_account(account_id)
    if not account:
        return {"success": False, "count": 0, "items": [], "message": "Tài khoản không tồn tại"}

    add_log(f"Bắt đầu quét dữ liệu '{action}' trên tài khoản Zalo '{account['name']}' qua API siêu tốc...", "INFO", account_id=account_id)

    # 1. Kiểm tra trạng thái phiên API
    sess = await zalo_bridge.get_session_status(account_id)
    if not sess.get("active") and not sess.get("has_saved_session"):
        msg = f"Tài khoản '{account['name']}' chưa kết nối Zalo hoặc phiên đã hết hạn. Vui lòng bấm 'Kết nối QR' trong mục Quản lý Tài khoản để kết nối!"
        add_log(msg, "WARNING", account_id=account_id)
        return {"success": False, "action": action, "count": 0, "items": [], "message": msg}

    try:
        # 1. Quét danh sách Nhóm Zalo (Groups)
        if action == "zalo_groups":
            groups = await zalo_bridge.get_all_groups(account_id)
            if groups is not None:
                add_log(f"Đã quét thành công {len(groups)} nhóm Zalo qua API siêu tốc (zca-js)!", "SUCCESS", account_id=account_id)
                return {"success": True, "action": action, "count": len(groups), "items": groups}
            return {
                "success": False,
                "action": action,
                "count": 0,
                "items": [],
                "message": "Không thể lấy danh sách nhóm qua API. Vui lòng kiểm tra lại kết nối QR của tài khoản!"
            }

        # 2. Quét Thành viên Nhóm Zalo (Group Members)
        elif action == "zalo_group_members":
            target_group = options.get("zaloGroupId") or options.get("group_name") or ""
            group_name = options.get("group_name") or ""

            # Nếu target_group là DOM ID giả (dom_grp_...), tra cứu UID thực từ danh sách nhóm API
            if str(target_group).startswith("dom_grp_") and group_name:
                all_grps = await zalo_bridge.get_all_groups(account_id)
                if all_grps:
                    matched = next((g for g in all_grps if g.get("name") == group_name or group_name in g.get("name", "")), None)
                    if matched:
                        target_group = matched.get("id") or matched.get("uid")
                        add_log(f"Đã ánh xạ nhóm '{group_name}' sang Zalo Group UID thực: {target_group}", "INFO", account_id=account_id)

            if not target_group or str(target_group).startswith("dom_grp_"):
                return {
                    "success": False,
                    "action": action,
                    "count": 0,
                    "items": [],
                    "message": "Chưa xác định được ID nhóm cần quét. Vui lòng chọn một nhóm từ danh sách nhóm để quét thành viên!"
                }

            add_log(f"Đang gửi yêu cầu trích xuất thành viên nhóm UID '{target_group}' qua API...", "INFO", account_id=account_id)
            res = await zalo_bridge.get_group_members(account_id, target_group)
            if res and res.get("success"):
                items = res.get("items", [])
                add_log(f"Đã quét thành công {len(items)} thành viên nhóm '{res.get('group_name')}' qua API!", "SUCCESS", account_id=account_id)
                return {
                    "success": True,
                    "action": action,
                    "count": len(items),
                    "items": items,
                    "is_hidden_members": res.get("is_hidden_members", False),
                    "message": res.get("message")
                }
            err_msg = (res.get("error") if res else None) or "Không thể lấy danh sách thành viên nhóm qua API."
            return {"success": False, "action": action, "count": 0, "items": [], "message": err_msg}

        # 3. Quét danh sách Bạn bè Zalo (Friends / Contacts)
        elif action in ["zalo_friends", "contacts"]:
            friends = await zalo_bridge.get_all_friends(account_id)
            if friends is not None:
                add_log(f"Đã quét thành công {len(friends)} bạn bè Zalo qua API siêu tốc!", "SUCCESS", account_id=account_id)
                return {"success": True, "action": action, "count": len(friends), "items": friends}
            return {
                "success": False,
                "action": action,
                "count": 0,
                "items": [],
                "message": "Không thể lấy danh sách bạn bè qua API. Vui lòng kiểm tra lại kết nối QR!"
            }

        return {"success": False, "count": 0, "items": [], "message": f"Hành động '{action}' không hợp lệ hoặc chưa hỗ trợ"}

    except Exception as e:
        add_log(f"Lỗi khi quét dữ liệu ({action}): {str(e)}", "ERROR", account_id=account_id)
        return {"success": False, "count": 0, "items": [], "message": str(e)}

# --- STREAMING DATA SCAN (NDJSON format matching akaAgent / agent.akabiz.net) ---
async def scan_zalo_data_stream(account_id: int, action: str, options: dict = None) -> AsyncGenerator[str, None]:
    options = options or {}
    yield json.dumps({"type": "progress", "stage": "init", "message": f"Bắt đầu khởi tạo quét '{action}'..."}) + "\n"
    await asyncio.sleep(0.1)

    sess = await zalo_bridge.get_session_status(account_id)
    if not sess.get("active") and not sess.get("has_saved_session"):
        msg = "Tài khoản chưa kết nối Zalo hoặc phiên đã hết hạn. Vui lòng kết nối QR trước!"
        yield json.dumps({"type": "error", "message": msg, "status": 401}) + "\n"
        return

    yield json.dumps({"type": "progress", "stage": "fetching", "message": "Đang kết nối Zalo API và trích xuất dữ liệu..."}) + "\n"

    res = await scan_zalo_data(account_id, action, options)
    if not res.get("success"):
        yield json.dumps({"type": "error", "message": res.get("message", "Lỗi quét dữ liệu"), "status": 500}) + "\n"
        return

    items = res.get("items", [])
    is_hidden = res.get("is_hidden_members", False)
    total_count = res.get("count", len(items))

    if is_hidden and total_count == 0:
        yield json.dumps({
            "type": "hidden_notice",
            "message": res.get("message") or "Nhóm đã bật ẩn danh sách thành viên đối với tài khoản không phải quản trị viên.",
            "is_hidden_members": True
        }) + "\n"
        yield json.dumps({"type": "result", "result": {"count": 0, "items": [], "action": action, "is_hidden_members": True}}) + "\n"
        return

    yield json.dumps({"type": "progress", "stage": "streaming", "total": total_count, "message": f"Đã tìm thấy {total_count} mục. Đang truyền dữ liệu..."}) + "\n"

    # Stream items in fast chunks for real-time visual rendering
    chunk_size = 5
    for i in range(0, len(items), chunk_size):
        chunk = items[i:i + chunk_size]
        yield json.dumps({
            "type": "chunk",
            "items": chunk,
            "current": min(i + chunk_size, len(items)),
            "total": total_count
        }) + "\n"
        await asyncio.sleep(0.02)

    yield json.dumps({
        "type": "result",
        "result": {
            "count": total_count,
            "items": items,
            "action": action,
            "is_hidden_members": is_hidden,
            "zaloGroupId": options.get("zaloGroupId") if options else None
        }
    }) + "\n"

# --- ZALO PHONE CHECK AUTOMATION ---
async def check_phone_numbers(account_id: int, phone_list: List[str]) -> Dict[str, Any]:
    account = get_account(account_id)
    if not account:
        return {"success": False, "message": "Tài khoản không tồn tại"}

    add_log(f"Bắt đầu kiểm tra {len(phone_list)} số điện thoại trên Zalo '{account['name']}'...", "INFO", account_id=account_id)

    # 0. Thử kiểm tra siêu tốc qua API (zca-js) trước
    try:
        sess = await zalo_bridge.get_session_status(account_id)
        if sess.get("active") or sess.get("has_saved_session"):
            api_phones = await zalo_bridge.check_phones(account_id, phone_list)
            if api_phones is not None:
                found_cnt = sum(1 for p in api_phones if p.get("found"))
                not_found_cnt = len(api_phones) - found_cnt
                add_log(f"Đã kiểm tra {len(api_phones)} SĐT qua API Zalo! Có Zalo: {found_cnt}, Chưa đăng ký: {not_found_cnt}", "SUCCESS", account_id=account_id)
                formatted_results = [
                    {
                        "phone": p["phone"],
                        "has_zalo": p.get("found", False),
                        "name": p.get("name") or f"SĐT {p['phone']}",
                        "avatar": p.get("avatar", ""),
                        "status": "found" if p.get("found") else "not_found",
                        "gender": p.get("gender", "")
                    }
                    for p in api_phones
                ]
                return {
                    "success": True,
                    "total": len(api_phones),
                    "found": found_cnt,
                    "not_found": not_found_cnt,
                    "results": formatted_results
                }
    except Exception as api_err:
        add_log(f"API zca-js phone check chưa sẵn sàng ({str(api_err)}), chuyển sang kiểm tra qua trình duyệt...", "WARNING", account_id=account_id)

    # API không sẵn sàng → trả lỗi rõ ràng, KHÔNG mở browser (tránh xung đột session Zalo)
    add_log("API zca-js chưa sẵn sàng. Vui lòng kết nối QR trong mục Tài khoản Profile trước khi kiểm tra SĐT.", "ERROR", account_id=account_id)
    return {
        "success": False,
        "message": "Phiên API chưa sẵn sàng. Vui lòng quét QR kết nối Zalo trong mục Quản lý Tài khoản trước!"
    }

async def check_phone_numbers_stream(account_id: int, phone_list: List[str]) -> AsyncGenerator[str, None]:
    yield json.dumps({"type": "progress", "stage": "start", "message": f"Bắt đầu kiểm tra {len(phone_list)} SĐT..."}) + "\n"
    res = await check_phone_numbers(account_id, phone_list)
    for r in res.get("results", []):
        yield json.dumps({"type": "row", "event": r}) + "\n"
        await asyncio.sleep(0.05)
    yield json.dumps({"type": "result", "result": res}) + "\n"

# --- LEGACY SYNC WRAPPER ---
async def sync_zalo_contacts(account_id: int) -> Dict[str, Any]:
    res = await scan_zalo_data(account_id, "zalo_friends")
    if res.get("success") and res.get("items"):
        contacts = []
        for item in res["items"]:
            contacts.append({
                "name": item.get("name", "Bạn bè Zalo"),
                "phone": item.get("uid", item.get("name")),
                "group_name": "Zalo Bạn bè",
                "tag": "Đồng bộ tự động"
            })
        added = bulk_add_contacts(contacts)
        add_log(f"Đã lưu thành công {added} liên hệ vào danh bạ!", "SUCCESS", account_id=account_id)
        return {"success": True, "count": added}
    return res

async def test_proxy(proxy_id: int) -> Dict[str, Any]:
    proxy = get_proxy(proxy_id)
    if not proxy:
        return {"success": False, "message": "Proxy không tồn tại"}

    await browser_manager.ensure_playwright()
    add_log(f"Bắt đầu kiểm tra Proxy #{proxy_id}: {proxy['server']}...", "INFO")

    proxy_config = {"server": proxy["server"]}
    if proxy.get("username") and proxy.get("password"):
        proxy_config["username"] = proxy["username"]
        proxy_config["password"] = proxy["password"]

    try:
        browser = await browser_manager.playwright.chromium.launch(
            headless=True,
            proxy=proxy_config,
            args=["--no-sandbox"]
        )
        page = await browser.new_page()
        start_time = asyncio.get_event_loop().time()
        response = await page.goto("https://api.ipify.org?format=json", timeout=15000)
        elapsed = int((asyncio.get_event_loop().time() - start_time) * 1000)

        if response and response.ok:
            content = await page.content()
            await browser.close()
            update_proxy_status(proxy_id, "active")
            msg = f"Proxy HOẠT ĐỘNG TỐT (Ping: {elapsed}ms) - Dữ liệu IP: {content[:100]}"
            add_log(msg, "SUCCESS")
            return {"success": True, "ping": elapsed, "ip_data": content}
        else:
            await browser.close()
            update_proxy_status(proxy_id, "dead")
            add_log("Proxy phản hồi lỗi HTTP", "WARNING")
            return {"success": False, "message": "Proxy phản hồi lỗi"}
    except Exception as e:
        update_proxy_status(proxy_id, "dead")
        add_log(f"Proxy LỖI KẾT NỐI: {str(e)}", "ERROR")
        return {"success": False, "message": str(e)}

# --- CORE CAMPAIGN ENGINE (Mapping akaAgent Action Codes) ---
async def run_campaign_task(campaign_id: int):
    from core.database import get_campaign
    campaign = get_campaign(campaign_id)
    if not campaign:
        return

    update_campaign_progress(campaign_id, 0, 0, 0, status="running")
    add_log(f"Bắt đầu thực thi chiến dịch #{campaign_id}: {campaign['name']} (Hành động: {campaign['action_type']})", "INFO", campaign_id=campaign_id)

    try:
        account_ids = json.loads(campaign["account_ids"]) if campaign.get("account_ids") else []
        params = json.loads(campaign["parameters"]) if campaign.get("parameters") else {}
    except:
        account_ids = []
        params = {}

    if not account_ids:
        add_log("Chiến dịch chưa chọn tài khoản thực thi nào", "ERROR", campaign_id=campaign_id)
        update_campaign_progress(campaign_id, 0, 0, 0, status="completed")
        return

    action_type = campaign.get("action_type", "zalo_message_phone")
    targets = params.get("targets", [])
    raw_message = params.get("message", "Xin chào bạn!")
    delay_min = int(params.get("delay_min", 3))
    delay_max = int(params.get("delay_max", 7))
    total = len(targets)
    success = 0
    fail = 0

    # 1. Action: Facebook Newsfeed Interaction (Nuôi nick)
    if action_type in ["facebook_newsfeed_interaction", "surf_feed"]:
        add_log("Bắt đầu kịch bản Lướt Newsfeed và tương tác tự động...", "INFO", campaign_id=campaign_id)
        for idx, acc_id in enumerate(account_ids):
            try:
                acc = get_account(acc_id)
                add_log(f"[{idx+1}/{len(account_ids)}] Tài khoản '{acc['name']}' đang lướt tương tác...", "INFO", campaign_id=campaign_id, account_id=acc_id)
                page = await browser_manager.launch_account_browser(acc_id, headless=False, target_url="https://facebook.com")
                await asyncio.sleep(5)
                # Scroll down 4 times
                for _ in range(4):
                    await page.mouse.wheel(0, 600)
                    await asyncio.sleep(random.uniform(2, 4))
                success += 1
            except Exception as e:
                fail += 1
                add_log(f"Lỗi: {str(e)}", "ERROR", campaign_id=campaign_id, account_id=acc_id)
            prog = int(((idx + 1) / len(account_ids)) * 100)
            update_campaign_progress(campaign_id, prog, success, fail)

    # 2. Action: Facebook Timeline Post (Đăng bài trang cá nhân)
    elif action_type == "facebook_timeline_post":
        for idx, acc_id in enumerate(account_ids):
            try:
                acc = get_account(acc_id)
                add_log(f"Đăng bài lên Facebook tài khoản '{acc['name']}'...", "INFO", campaign_id=campaign_id, account_id=acc_id)
                page = await browser_manager.launch_account_browser(acc_id, headless=False, target_url="https://facebook.com")
                await asyncio.sleep(4)
                post_box = await page.query_selector("div[role='button']:has-text('bạn đang nghĩ gì'), div[role='button']:has-text('on your mind')")
                if post_box:
                    await post_box.click()
                    await asyncio.sleep(2)
                    input_area = await page.query_selector("div[contenteditable='true'][role='textbox']")
                    if input_area:
                        await input_area.fill(raw_message)
                        await asyncio.sleep(2)
                        submit_btn = await page.query_selector("div[aria-label='Đăng'], div[aria-label='Post']")
                        if submit_btn:
                            await submit_btn.click()
                            add_log(f"Đã đăng bài thành công trên '{acc['name']}'!", "SUCCESS", campaign_id=campaign_id, account_id=acc_id)
                            success += 1
                else:
                    add_log("Không tìm thấy khung đăng bài (vui lòng kiểm tra đăng nhập)", "WARNING", campaign_id=campaign_id, account_id=acc_id)
                    fail += 1
            except Exception as e:
                fail += 1
                add_log(f"Lỗi đăng bài: {str(e)}", "ERROR", campaign_id=campaign_id, account_id=acc_id)
            prog = int(((idx + 1) / len(account_ids)) * 100)
            update_campaign_progress(campaign_id, prog, success, fail)

    # 3. Actions on Targets (Zalo message to phone, friend, group, group member, birthday)
    else:
        if total == 0:
            add_log("Chiến dịch gửi tin không có danh sách mục tiêu nào (targets rỗng)", "WARNING", campaign_id=campaign_id)
            update_campaign_progress(campaign_id, 100, 0, 0, status="completed")
            return

        acc_idx = 0
        for i, target in enumerate(targets):
            current_acc_id = account_ids[acc_idx % len(account_ids)]
            acc_idx += 1

            # Personalize message: replace [fullname], [phone], {name}, {phone}
            target_str = str(target).strip()
            personalized_msg = (
                raw_message.replace("[fullname]", target_str)
                           .replace("[fullname_web]", target_str)
                           .replace("{name}", target_str)
                           .replace("[phone]", target_str)
                           .replace("{phone}", target_str)
                           .replace("[VOCATIVE_WEB]", "bạn")
                           .replace("[vocative_web]", "bạn")
            )

            add_log(f"[{i+1}/{total}] Thực hiện gửi tới '{target_str}' qua tài khoản ID {current_acc_id}...", "INFO", campaign_id=campaign_id, account_id=current_acc_id)
            
            # Thử gửi siêu tốc bằng API (zca-js) trước
            sent_via_api = False
            try:
                sess_status = await zalo_bridge.get_session_status(current_acc_id)
                if sess_status.get("active") or sess_status.get("has_saved_session"):
                    is_grp = (action_type in ["zalo_message_group", "group"]) or target_str.startswith("g")
                    res_api = await zalo_bridge.send_message(current_acc_id, target_str, personalized_msg, is_group=is_grp)
                    if res_api.get("success"):
                        sent_via_api = True
                        success += 1
                        add_log(f"Đã gửi tin thành công tới '{target_str}' qua API siêu tốc (zca-js)!", "SUCCESS", campaign_id=campaign_id, account_id=current_acc_id)
            except Exception:
                pass

            if not sent_via_api:
                # KHÔNG mở browser fallback → tránh xung đột session Zalo
                fail += 1
                add_log(f"Không thể gửi tin tới '{target_str}': Phiên API chưa sẵn sàng. Hãy kết nối QR trước!", "WARNING", campaign_id=campaign_id, account_id=current_acc_id)

            progress_pct = int(((i + 1) / total) * 100)
            update_campaign_progress(campaign_id, progress_pct, success, fail)

            # Random human delay
            sleep_time = random.uniform(delay_min, delay_max)
            add_log(f"Tạm nghỉ ngẫu nhiên {sleep_time:.1f}s trước lượt tiếp theo...", "INFO", campaign_id=campaign_id)
            await asyncio.sleep(sleep_time)

    update_campaign_progress(campaign_id, 100, success, fail, status="completed")
    add_log(f"Hoàn thành chiến dịch #{campaign_id}! Thành công: {success}, Thất bại: {fail}", "SUCCESS", campaign_id=campaign_id)
