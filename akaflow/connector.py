from __future__ import annotations

from typing import Any

import httpx


class ZaloConnector:
    """Small adapter for AkaFlow's loopback-only Node service."""

    def __init__(self, base_url: str = "http://127.0.0.1:8001") -> None:
        self.base_url = base_url.rstrip("/")

    async def request(
        self,
        method: str,
        path: str,
        *,
        timeout: float = 30.0,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                f"{self.base_url}{path}",
                json=json,
            )
        try:
            payload = response.json()
        except ValueError:
            payload = {"error": response.text[:300] or "Invalid connector response"}
        if response.status_code >= 400:
            payload.setdefault("success", False)
            payload.setdefault("status_code", response.status_code)
        return payload

    async def health(self) -> dict[str, Any]:
        try:
            return await self.request("GET", "/api/health", timeout=3)
        except httpx.HTTPError as exc:
            return {"status": "offline", "error": str(exc)}

    async def session_status(self, account_id: int) -> dict[str, Any]:
        return await self.request(
            "GET", f"/api/session/status?account_id={account_id}", timeout=10
        )

    async def qr_start(self, account_id: int) -> dict[str, Any]:
        return await self.request(
            "POST", "/api/login-qr/start", json={"account_id": account_id}
        )

    async def qr_status(self, account_id: int) -> dict[str, Any]:
        return await self.request(
            "GET", f"/api/login-qr/status?account_id={account_id}", timeout=10
        )

    async def groups(self, account_id: int) -> dict[str, Any]:
        return await self.request(
            "GET", f"/api/account/{account_id}/groups", timeout=45
        )

    async def group_members(
        self, account_id: int, group_id: str, extra_uids: list[str] | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"groupId": group_id}
        if extra_uids:
            payload["extraUids"] = extra_uids
        return await self.request(
            "POST",
            f"/api/account/{account_id}/group-members",
            timeout=90,
            json=payload,
        )

    async def group_link_members(self, account_id: int, link: str) -> dict[str, Any]:
        return await self.request(
            "POST",
            f"/api/account/{account_id}/group-link-members",
            timeout=45,
            json={"link": link},
        )

    async def friends(self, account_id: int) -> dict[str, Any]:
        return await self.request(
            "GET", f"/api/account/{account_id}/friends", timeout=45
        )

    async def send_message(
        self, account_id: int, recipient_id: str, message: str
    ) -> dict[str, Any]:
        return await self.request(
            "POST",
            f"/api/account/{account_id}/send-message",
            timeout=30,
            json={"toId": recipient_id, "message": message, "isGroup": False},
        )


zalo = ZaloConnector()
