const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const PROFILES_DIR = path.join(__dirname, '..', 'browser_profiles');
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

class BrowserManager {
  constructor() {
    this.activeContexts = new Map(); // accountKey -> context
    this.activePages = new Map(); // accountKey -> page
  }

  getProfilePath(platform, accountId) {
    const dir = path.join(PROFILES_DIR, `${platform}_${accountId}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async launchBrowser(platform, accountId, options = {}) {
    const key = `${platform}_${accountId}`;
    if (this.activePages.has(key)) {
      const page = this.activePages.get(key);
      if (!page.isClosed()) {
        return page;
      }
    }

    const profileDir = this.getProfilePath(platform, accountId);
    const headless = options.headless !== undefined ? options.headless : false; // default visible for desktop automation

    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: '/usr/bin/google-chrome',
      headless,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-first-run',
        '--password-store=basic'
      ]
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    // Anti-bot stealth patches
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    this.activeContexts.set(key, context);
    this.activePages.set(key, page);

    page.on('close', () => {
      this.activePages.delete(key);
      this.activeContexts.delete(key);
    });

    return page;
  }

  async closeBrowser(platform, accountId) {
    const key = `${platform}_${accountId}`;
    if (this.activeContexts.has(key)) {
      const ctx = this.activeContexts.get(key);
      await ctx.close().catch(() => {});
      this.activeContexts.delete(key);
      this.activePages.delete(key);
    }
  }

  async humanDelay(minSec = 2, maxSec = 5) {
    const ms = Math.floor((Math.random() * (maxSec - minSec) + minSec) * 1000);
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = new BrowserManager();
