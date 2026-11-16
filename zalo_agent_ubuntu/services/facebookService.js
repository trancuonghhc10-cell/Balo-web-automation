const browserManager = require('./browserManager');
const db = require('../db');
const { renderMessage } = require('../spintax');

class FacebookService {
  async openLogin(accountId) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    return { ok: true, message: 'Đã mở trình duyệt Facebook Chrome. Hãy đăng nhập tài khoản một lần, phiên sẽ được lưu vĩnh viễn!' };
  }

  async checkLoginStatus(accountId) {
    try {
      const page = await browserManager.launchBrowser('facebook', accountId, { headless: true });
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      await browserManager.humanDelay(2, 3);
      const isLoggedIn = await page.evaluate(() => {
        return !!(document.querySelector('div[role="feed"]') || document.querySelector('div[role="navigation"]') || document.querySelector('[aria-label="Tài khoản của bạn"]'));
      });
      return { ok: true, isLoggedIn };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- 1. NUÔI NICK & TƯƠNG TÁC NEWSFEED ---
  async newsfeedFb(accountId, minutes = 5, likeRate = 0.4, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    broadcast({ type: 'task_log', message: `Bắt đầu nuôi nick lướt Newsfeed Facebook trong ${minutes} phút...` });

    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    const endTime = Date.now() + minutes * 60 * 1000;
    let likeCount = 0;
    let scrollCount = 0;

    while (Date.now() < endTime) {
      scrollCount++;
      // Natural human scroll down
      const scrollStep = Math.floor(Math.random() * 400 + 300);
      await page.mouse.wheel(0, scrollStep);
      broadcast({ type: 'task_log', message: `[Cuộn #${scrollCount}] Đang lướt đọc bài viết trên bảng tin...` });

      // Human delay reading post
      await browserManager.humanDelay(3, 7);

      // Random like decision
      if (Math.random() < likeRate) {
        try {
          const likeButtons = await page.locator('div[aria-label="Thích"], div[aria-label="Like"]').all();
          if (likeButtons.length > 0) {
            const btn = likeButtons[Math.floor(Math.random() * Math.min(3, likeButtons.length))];
            if (await btn.isVisible()) {
              await btn.click();
              likeCount++;
              broadcast({ type: 'task_log', message: `❤️ Đã thả Thích bài viết (Tổng đã thích: ${likeCount})` });
              await browserManager.humanDelay(2, 4);
            }
          }
        } catch (e) {}
      }
    }

    broadcast({ type: 'task_log', message: `🎉 Hoàn thành phiên nuôi nick Facebook! Cuộn: ${scrollCount} lần, Thích: ${likeCount} bài viết.` });
    return { ok: true, scrollCount, likeCount };
  }

  // --- 2. ĐĂNG BÀI PROFILE / GROUP / REELS ---
  async postToMyProfileFb(accountId, contentText, mediaUrl = '', broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    broadcast({ type: 'task_log', message: 'Mở trang chủ Facebook để chuẩn bị đăng bài cá nhân...' });

    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    // Look for "Bạn đang nghĩ gì thế?"
    const postBox = await page.locator('div[role="button"]:has-text("Bạn đang nghĩ gì thế"), div[role="button"]:has-text("What\'s on your mind")').first();
    if (!await postBox.isVisible()) {
      throw new Error('Không tìm thấy khung đăng bài. Vui lòng kiểm tra trạng thái đăng nhập Facebook!');
    }

    await postBox.click();
    await browserManager.humanDelay(2, 3);

    const inputArea = await page.locator('div[contenteditable="true"][role="textbox"]').first();
    const finalContent = renderMessage(contentText);
    await inputArea.fill(finalContent);
    broadcast({ type: 'task_log', message: 'Đã nhập nội dung bài viết (Spintax rendered)...' });
    await browserManager.humanDelay(2, 3);

    // Click "Đăng" / "Post"
    const submitBtn = await page.locator('div[aria-label="Đăng"], div[aria-label="Post"]').first();
    await submitBtn.click();
    broadcast({ type: 'task_log', message: '✅ Đã bấm Đăng bài lên trang cá nhân thành công!' });
    await browserManager.humanDelay(3, 5);

    return { ok: true, content: finalContent };
  }

  async postToGroupFb(accountId, groupIdOrUrl, contentText, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    const targetUrl = groupIdOrUrl.startsWith('http') ? groupIdOrUrl : `https://www.facebook.com/groups/${groupIdOrUrl}`;
    broadcast({ type: 'task_log', message: `Mở nhóm Facebook: ${targetUrl}...` });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    const postBox = await page.locator('div[role="button"]:has-text("Viết gì đó"), div[role="button"]:has-text("Tạo bài viết")').first();
    if (await postBox.isVisible()) {
      await postBox.click();
      await browserManager.humanDelay(2, 3);

      const inputArea = await page.locator('div[contenteditable="true"][role="textbox"]').first();
      const finalContent = renderMessage(contentText);
      await inputArea.fill(finalContent);
      await browserManager.humanDelay(2, 4);

      const submitBtn = await page.locator('div[aria-label="Đăng"], div[aria-label="Post"]').first();
      await submitBtn.click();
      broadcast({ type: 'task_log', message: '✅ Đã đăng bài vào nhóm thành công!' });
      return { ok: true, group: targetUrl };
    } else {
      throw new Error('Không tìm thấy khung đăng bài trong nhóm (chưa tham gia hoặc nhóm cấm đăng).');
    }
  }

  // --- 3. KẾT BẠN & LỜI MỜI ---
  async addFriendsRecommendFb(accountId, limit = 10, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    broadcast({ type: 'task_log', message: `Mở trang Bạn bè gợi ý (mục tiêu: ${limit} người)...` });

    await page.goto('https://www.facebook.com/friends/suggestions', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    let sent = 0;
    const addButtons = await page.locator('div[aria-label="Thêm bạn bè"], button:has-text("Thêm bạn bè")').all();
    for (const btn of addButtons) {
      if (sent >= limit) break;
      try {
        if (await btn.isVisible()) {
          await btn.click();
          sent++;
          broadcast({ type: 'task_log', message: `[${sent}/${limit}] Đã gửi lời mời kết bạn gợi ý!` });
          await browserManager.humanDelay(3, 7);
        }
      } catch (e) {}
    }

    broadcast({ type: 'task_log', message: `Hoàn tất gửi kết bạn Facebook: ${sent} lời mời!` });
    return { ok: true, sent };
  }

  async acceptAddFriendsFb(accountId, limit = 20, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    broadcast({ type: 'task_log', message: 'Mở trang Lời mời kết bạn để đồng ý...' });

    await page.goto('https://www.facebook.com/friends/requests', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    let count = 0;
    const confirmButtons = await page.locator('div[aria-label="Xác nhận"], button:has-text("Xác nhận")').all();
    for (const btn of confirmButtons) {
      if (count >= limit) break;
      try {
        if (await btn.isVisible()) {
          await btn.click();
          count++;
          broadcast({ type: 'task_log', message: `[${count}/${limit}] Đã chấp nhận lời mời kết bạn!` });
          await browserManager.humanDelay(2, 4);
        }
      } catch (e) {}
    }

    broadcast({ type: 'task_log', message: `Hoàn tất đồng ý ${count} bạn bè trên Facebook!` });
    return { ok: true, count };
  }

  // --- 4. QUÉT TƯƠNG TÁC (SCRAPER) ---
  async loadUidCmtFromPost(accountId, postUrl, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('facebook', accountId, { headless: false });
    broadcast({ type: 'task_log', message: `Đang quét bình luận từ bài viết: ${postUrl}...` });

    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(3, 5);

    const comments = await page.evaluate(() => {
      const list = [];
      const cmtNodes = document.querySelectorAll('div[role="article"]');
      cmtNodes.forEach(node => {
        const author = node.querySelector('span[dir="auto"], a')?.innerText || '';
        const link = node.querySelector('a')?.href || '';
        const text = node.innerText || '';
        if (author) {
          list.push({ author, link, text });
        }
      });
      return list;
    });

    broadcast({ type: 'task_log', message: `Quét thành công ${comments.length} bình luận từ bài viết!` });
    return { ok: true, comments };
  }
}

module.exports = new FacebookService();
