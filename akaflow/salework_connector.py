from __future__ import annotations

from typing import Any

import httpx


class SaleworkError(RuntimeError):
    pass


class SaleworkConnector:
    """Adapter for the documented Salework Zalo Open API."""

    def __init__(self, base_url: str = "https://salework.net/api/open/zalo/v1") -> None:
        self.base_url = base_url

    async def call(
        self,
        client_id: str,
        token: str,
        service: str,
        method: str,
        data: dict[str, Any] | None = None,
        *,
        timeout: float = 30.0,
    ) -> Any:
        headers = {
            "Content-Type": "application/json",
            "client-id": client_id,
            "token": token,
        }
        body = {"service": service, "method": method, "data": data or {}}
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=False,
            ) as client:
                response = await client.post(self.base_url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise SaleworkError(f"Không kết nối được Salework: {exc}") from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise SaleworkError(
                f"Salework trả dữ liệu không hợp lệ (HTTP {response.status_code})"
            ) from exc

        if response.status_code >= 400 or payload.get("status") != "success":
            error = payload.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else str(error)
            raise SaleworkError(
                message or f"Salework từ chối yêu cầu (HTTP {response.status_code})"
            )

        envelope = payload.get("data")
        if isinstance(envelope, dict) and "error_code" in envelope:
            if int(envelope.get("error_code") or 0) != 0:
                raise SaleworkError(
                    str(envelope.get("error_message") or "Salework báo lỗi")
                )
            return envelope.get("data")
        return envelope

    async def group_info(
        self,
        client_id: str,
        token: str,
        salework_account_id: str,
        group_id: str,
    ) -> dict[str, Any]:
        result = await self.call(
            client_id,
            token,
            "contact",
            "getGroupInfo",
            {"accountId": salework_account_id, "groupId": group_id},
        )
        return result if isinstance(result, dict) else {}

    async def member_profiles(
        self,
        client_id: str,
        token: str,
        salework_account_id: str,
        member_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        profiles: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(member_ids), 50):
            batch = member_ids[offset : offset + 50]
            result = await self.call(
                client_id,
                token,
                "contact",
                "getGroupMembers",
                {"accountId": salework_account_id, "friendMap": batch},
                timeout=45,
            )
            if not isinstance(result, dict):
                continue
            raw_profiles = result.get("profiles") or {}
            if isinstance(raw_profiles, dict):
                for key, profile in raw_profiles.items():
                    if isinstance(profile, dict):
                        uid = str(profile.get("id") or key).split("_")[0].strip()
                        if uid.isdigit():
                            profiles[uid] = profile
        return profiles


salework = SaleworkConnector()
