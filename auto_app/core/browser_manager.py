import os
import asyncio
from typing import Dict, Optional, Any
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright
from core.database import get_account, get_proxy, update_account_status, add_log

BASE_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
PROFILES_DIR = os.path.join(BASE_DATA_DIR, "profiles")

class BrowserManager:
    def __init__(self):
        self.playwright: Optional[Playwright] = None
        self.active_contexts: Dict[int, BrowserContext] = {}
        self.active_pages: Dict[int, Page] = {}

    async def ensure_playwright(self):
        if not self.playwright:
            self.playwright = await async_playwright().start()

    def get_profile_path(self, account_id: int) -> str:
        path = os.path.join(PROFILES_DIR, f"acc_{account_id}")
        os.makedirs(path, exist_ok=True)
        return path

    async def launch_account_browser(
        self,
        account_id: int,
        headless: bool = False,
        target_url: str = None
    ) -> Page:
        await self.ensure_playwright()

        # If already open, return active page
        if account_id in self.active_contexts:
            ctx = self.active_contexts[account_id]
            pages = ctx.pages
            if pages:
                page = pages[0]
                if target_url:
                    await page.goto(target_url)
                return page

        account = get_account(account_id)
        if not account:
            raise ValueError(f"Tài khoản ID {account_id} không tồn tại")

        user_data_dir = self.get_profile_path(account_id)

        # Launch options
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-dev-shm-usage",
            "--window-size=1280,800"
        ]

        proxy_config = None
        if account.get("proxy_id"):
            proxy = get_proxy(account["proxy_id"])
            if proxy:
                proxy_config = {"server": proxy["server"]}
                if proxy.get("username") and proxy.get("password"):
                    proxy_config["username"] = proxy["username"]
                    proxy_config["password"] = proxy["password"]
                add_log(f"Khởi chạy profile với Proxy: {proxy['server']}", "INFO", account_id=account_id)

        add_log(f"Khởi chạy trình duyệt tài khoản '{account['name']}' (Headless={headless})...", "INFO", account_id=account_id)
        update_account_status(account_id, "running")

        context = await self.playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=headless,
            viewport={"width": 1280, "height": 800},
            args=launch_args,
            proxy=proxy_config,
            locale="vi-VN",
            timezone_id="Asia/Ho_Chi_Minh"
        )

        # Add stealth script to remove webdriver traces
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            window.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };
        """)

        pages = context.pages
        page = pages[0] if pages else await context.new_page()

        self.active_contexts[account_id] = context
        self.active_pages[account_id] = page

        # Hook on close
        context.on("close", lambda: self._on_context_closed(account_id))

        if target_url:
            await page.goto(target_url, wait_until="domcontentloaded")

        return page

    def _on_context_closed(self, account_id: int):
        if account_id in self.active_contexts:
            del self.active_contexts[account_id]
        if account_id in self.active_pages:
            del self.active_pages[account_id]
        update_account_status(account_id, "ready")
        add_log(f"Đã đóng trình duyệt tài khoản ID {account_id}", "INFO", account_id=account_id)

    async def close_account_browser(self, account_id: int):
        if account_id in self.active_contexts:
            ctx = self.active_contexts[account_id]
            await ctx.close()
            self._on_context_closed(account_id)

    def is_browser_running(self, account_id: int) -> bool:
        return account_id in self.active_contexts

    async def extract_zalo_session(self, account_id: int) -> Optional[Dict[str, Any]]:
        page = self.active_pages.get(account_id)
        context = self.active_contexts.get(account_id)
        if not page or not context:
            return None
        
        try:
            cookies = await context.cookies()
            if not cookies:
                return None

            imei = None
            user_agent = None
            try:
                imei = await page.evaluate("localStorage.getItem('z_uuid') || localStorage.getItem('sh_z_uuid')")
                user_agent = await page.evaluate("navigator.userAgent")
            except Exception:
                pass

            if not user_agent:
                user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

            return {
                "account_id": account_id,
                "cookies": cookies,
                "imei": imei,
                "userAgent": user_agent
            }
        except Exception as e:
            add_log(f"Lỗi trích xuất session từ trình duyệt: {e}", "WARNING", account_id=account_id)
            return None

    async def shutdown(self):
        for acc_id, ctx in list(self.active_contexts.items()):
            try:
                await ctx.close()
            except:
                pass
        if self.playwright:
            await self.playwright.stop()
            self.playwright = None

# Global instance
browser_manager = BrowserManager()
