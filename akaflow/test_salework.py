from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import app
import database as db
from starlette.requests import Request


class SaleworkSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "test.db"
        db.init_db()
        self.account_id = db.execute("INSERT INTO accounts(name) VALUES ('test')")
        db.execute(
            """
            INSERT INTO salework_integrations(
                account_id, client_id, token, salework_account_id,
                webhook_secret, enabled
            ) VALUES (?, 'client', 'token', '99999', 'secret', 1)
            """,
            (self.account_id,),
        )
        self.original_group_info = app.salework.group_info
        self.original_member_profiles = app.salework.member_profiles

    def tearDown(self) -> None:
        app.salework.group_info = self.original_group_info
        app.salework.member_profiles = self.original_member_profiles
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def install_response(self, group: dict[str, Any]) -> None:
        async def group_info(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
            return {"gridInfoMap": {"12345": group}}

        async def member_profiles(
            *_args: Any, member_ids: list[str] | None = None, **_kwargs: Any
        ) -> dict[str, dict[str, Any]]:
            ids = member_ids or (_args[-1] if _args else [])
            return {
                uid: {"id": uid, "displayName": f"User {uid}"}
                for uid in ids
            }

        app.salework.group_info = group_info
        app.salework.member_profiles = member_profiles

    def test_visible_group_uses_mem_ver_list(self) -> None:
        self.install_response(
            {
                "creatorId": "11111",
                "adminIds": [],
                "memberIds": [],
                "currentMems": [],
                "memVerList": ["11111_0", "22222_1", "33333_2"],
                "totalMember": 3,
                "setting": {"lockViewMember": 0},
            }
        )
        result = asyncio.run(app.salework_group_snapshot(self.account_id, "12345"))
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(len(result["items"]), 3)
        self.assertTrue(result["complete"])
        self.assertTrue(result["diagnostics"]["mem_ver_used"])

    def test_hidden_group_does_not_use_mem_ver_for_regular_member(self) -> None:
        self.install_response(
            {
                "creatorId": "11111",
                "adminIds": ["22222"],
                "memberIds": [],
                "currentMems": [],
                "memVerList": ["11111_0", "22222_1", "33333_2"],
                "totalMember": 3,
                "setting": {"lockViewMember": 1},
            }
        )
        result = asyncio.run(app.salework_group_snapshot(self.account_id, "12345"))
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual({item["uid"] for item in result["items"]}, {"11111", "22222"})
        self.assertFalse(result["complete"])
        self.assertFalse(result["diagnostics"]["mem_ver_used"])
        self.assertFalse(result["diagnostics"]["authorized_roster"])

    def test_webhook_records_identity_but_not_message_content(self) -> None:
        payload = json.dumps(
            {
                "type": "Notification",
                "zaloAccountId": "99999",
                "data": {
                    "groupMsgs": [
                        {
                            "idTo": "12345",
                            "uidFrom": "22222",
                            "dName": "Người gửi",
                            "content": "nội dung không được lưu",
                        }
                    ]
                },
            }
        ).encode()
        sent = False

        async def receive() -> dict[str, Any]:
            nonlocal sent
            if sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            sent = True
            return {"type": "http.request", "body": payload, "more_body": False}

        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/",
                "headers": [(b"content-length", str(len(payload)).encode())],
            },
            receive,
        )
        response = asyncio.run(
            app.salework_webhook(self.account_id, "secret", request)
        )
        self.assertEqual(response["accepted"], 1)
        stored = db.observed_members(self.account_id, "12345")
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["uid"], "22222")
        self.assertNotIn("nội dung", json.dumps(stored, ensure_ascii=False))

    def test_config_response_never_exposes_api_token(self) -> None:
        response = app.get_salework_config(self.account_id)
        self.assertTrue(response["configured"])
        self.assertTrue(response["token_set"])
        self.assertNotIn("token", response)
        self.assertNotIn("webhook_secret", response)
        self.assertTrue(response["webhook_path"].endswith("/secret"))


if __name__ == "__main__":
    unittest.main()
