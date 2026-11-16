import httpx
import asyncio
import logging
from typing import Dict, Any, List, Optional

logger = logging.getLogger("zalo_api_bridge")
SERVICE_URL = "http://127.0.0.1:8001"

MAX_RETRIES = 2
RETRY_DELAY = 1.0  # seconds


class ZaloApiBridge:
    def __init__(self, base_url: str = SERVICE_URL):
        self.base_url = base_url

    async def _request(self, method: str, path: str, timeout: float = 10.0, retries: int = MAX_RETRIES, **kwargs) -> Optional[Dict[str, Any]]:
        """Centralized HTTP request with retry logic and error handling."""
        url = f"{self.base_url}{path}"
        last_error = None
        for attempt in range(1, retries + 1):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    if method.upper() == "GET":
                        res = await client.get(url, **kwargs)
                    else:
                        res = await client.post(url, **kwargs)
                    if res.status_code == 200:
                        return res.json()
                    elif res.status_code == 401:
                        # Session expired — no retry needed
                        return res.json()
                    else:
                        last_error = f"HTTP {res.status_code}: {res.text[:200]}"
                        logger.warning(f"[Attempt {attempt}/{retries}] {method} {path} → {last_error}")
            except httpx.TimeoutException:
                last_error = f"Timeout after {timeout}s"
                logger.warning(f"[Attempt {attempt}/{retries}] {method} {path} → {last_error}")
            except httpx.ConnectError:
                last_error = "Không thể kết nối tới Zalo API Service (port 8001)"
                logger.error(f"[Attempt {attempt}/{retries}] {method} {path} → {last_error}")
            except Exception as e:
                last_error = str(e)
                logger.error(f"[Attempt {attempt}/{retries}] {method} {path} → {last_error}")

            if attempt < retries:
                await asyncio.sleep(RETRY_DELAY * attempt)

        return None

    async def is_service_alive(self) -> bool:
        result = await self._request("GET", "/api/health", timeout=3.0, retries=1)
        return result is not None and result.get("status") == "ok"

    async def get_session_status(self, account_id: int) -> Dict[str, Any]:
        result = await self._request("GET", f"/api/session/status?account_id={account_id}", timeout=5.0)
        if result:
            return result
        return {"active": False, "has_saved_session": False, "own_id": None}

    async def save_session(self, account_id: int, cookie: list, imei: str = None, user_agent: str = None) -> Dict[str, Any]:
        result = await self._request(
            "POST", "/api/session/save",
            timeout=10.0,
            json={
                "account_id": account_id,
                "cookie": cookie,
                "imei": imei,
                "userAgent": user_agent
            }
        )
        return result or {"success": False, "error": "Không thể kết nối tới service"}

    async def load_session(self, account_id: int) -> bool:
        result = await self._request("POST", "/api/session/load", timeout=10.0, json={"account_id": account_id})
        return bool(result and result.get("success"))

    async def start_qr_login(self, account_id: int) -> Dict[str, Any]:
        result = await self._request("POST", "/api/login-qr/start", timeout=10.0, json={"account_id": account_id})
        return result or {"success": False, "error": "Không thể kết nối tới service"}

    async def poll_qr_login(self, account_id: int) -> Dict[str, Any]:
        result = await self._request("GET", f"/api/login-qr/status?account_id={account_id}", timeout=5.0, retries=1)
        return result or {"status": "error", "error": "Không thể kết nối tới service"}

    async def abort_qr_login(self, account_id: int) -> Dict[str, Any]:
        result = await self._request("POST", "/api/login-qr/abort", timeout=5.0, retries=1, json={"account_id": account_id})
        return result or {"success": False}

    async def get_all_groups(self, account_id: int) -> Optional[List[Dict[str, Any]]]:
        result = await self._request("GET", f"/api/account/{account_id}/groups", timeout=25.0)
        if result and result.get("success"):
            return result.get("items", [])
        return None

    async def get_group_members(self, account_id: int, group_id: str) -> Optional[Dict[str, Any]]:
        result = await self._request(
            "POST", f"/api/account/{account_id}/group-members",
            timeout=60.0,  # Large groups with 500+ members need more time
            json={"groupId": group_id}
        )
        return result

    async def check_phones(self, account_id: int, phone_list: List[str]) -> Optional[List[Dict[str, Any]]]:
        result = await self._request(
            "POST", f"/api/account/{account_id}/phone-check",
            timeout=60.0,  # Each phone takes ~1-2s
            json={"phoneList": phone_list}
        )
        if result and result.get("success"):
            return result.get("items", [])
        return None

    async def get_all_friends(self, account_id: int) -> Optional[List[Dict[str, Any]]]:
        result = await self._request("GET", f"/api/account/{account_id}/friends", timeout=25.0)
        if result and result.get("success"):
            return result.get("items", [])
        return None

    async def send_message(self, account_id: int, to_id: str, message: str, is_group: bool = False, attachments: Optional[List[str]] = None) -> Dict[str, Any]:
        payload = {"toId": to_id, "message": message, "isGroup": is_group}
        if attachments:
            payload["attachments"] = attachments
        result = await self._request(
            "POST", f"/api/account/{account_id}/send-message",
            timeout=15.0,
            json=payload
        )
        return result or {"success": False, "error": "Không thể kết nối tới service"}

    async def send_friend_request(self, account_id: int, user_id: str, message: str = "Xin chào!") -> Dict[str, Any]:
        result = await self._request(
            "POST", f"/api/account/{account_id}/send-friend-request",
            timeout=15.0,
            json={"userId": user_id, "message": message}
        )
        return result or {"success": False, "error": "Không thể kết nối tới service"}

    async def add_user_to_group(self, account_id: int, group_id: str, user_ids: List[str]) -> Dict[str, Any]:
        result = await self._request(
            "POST", f"/api/account/{account_id}/add-user-to-group",
            timeout=20.0,
            json={"groupId": group_id, "userIds": user_ids}
        )
        return result or {"success": False, "error": "Không thể kết nối tới service"}

    async def toggle_listener(self, account_id: int, enable: bool, rules: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        result = await self._request(
            "POST", f"/api/account/{account_id}/listener",
            timeout=10.0,
            json={"enable": enable, "rules": rules or []}
        )
        return result or {"success": False, "error": "Không thể kết nối tới service"}


zalo_bridge = ZaloApiBridge()
