const browserManager = require('./browserManager');
const https = require('https');

class TikTokService {
  async openLogin(accountId) {
    const page = await browserManager.launchBrowser('tiktok', accountId, { headless: false });
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded' });
    return { ok: true, message: 'Đã mở TikTok Chrome. Hãy đăng nhập tài khoản một lần, phiên sẽ được lưu vĩnh viễn!' };
  }

  // --- 1. LƯỚT XEM VIDEO & TƯƠNG TÁC NGẪU NHIÊN ---
  async surfingTikTok(accountId, minutes = 5, interactRate = 0.4, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('tiktok', accountId, { headless: false });
    broadcast({ type: 'task_log', message: `Bắt đầu lướt TikTok For You Feed trong ${minutes} phút...` });

    await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(4, 6);

    const endTime = Date.now() + minutes * 60 * 1000;
    let videoCount = 0;
    let likedCount = 0;

    while (Date.now() < endTime) {
      videoCount++;
      broadcast({ type: 'task_log', message: `[Video #${videoCount}] Đang xem video...` });

      // Watch video for realistic duration (6s - 14s)
      const watchTime = Math.floor(Math.random() * 8 + 6);
      await new Promise(r => setTimeout(r, watchTime * 1000));

      // Random like interaction
      if (Math.random() < interactRate) {
        try {
          const likeBtn = await page.locator('span[data-e2e="like-icon"], button[aria-label*="Like"]').first();
          if (await likeBtn.isVisible()) {
            await likeBtn.click();
            likedCount++;
            broadcast({ type: 'task_log', message: `❤️ Đã thả tim video #${videoCount} (Tổng đã thích: ${likedCount})` });
            await browserManager.humanDelay(1, 2);
          }
        } catch (e) {}
      }

      // Next video via Keyboard Down Arrow
      await page.keyboard.press('ArrowDown');
      await browserManager.humanDelay(1, 3);
    }

    broadcast({ type: 'task_log', message: `🎉 Hoàn thành lướt TikTok! Xem: ${videoCount} video, Thả tim: ${likedCount} video.` });
    return { ok: true, videoCount, likedCount };
  }

  // --- 2. TƯƠNG TÁC CHI TIẾT TRONG VIDEO ---
  async reactInVideo(page) {
    const likeBtn = await page.locator('span[data-e2e="like-icon"], button[aria-label*="Like"]').first();
    if (await likeBtn.isVisible()) {
      await likeBtn.click();
      return true;
    }
    return false;
  }

  async cmtInVideo(page, commentText) {
    const cmtInput = await page.locator('div[contenteditable="true"][data-e2e="comment-input"], input[placeholder*="Add comment"]').first();
    if (await cmtInput.isVisible()) {
      await cmtInput.click();
      await cmtInput.fill(commentText);
      await browserManager.humanDelay(1, 2);
      await page.keyboard.press('Enter');
      return true;
    }
    return false;
  }

  async followInVideo(page) {
    const followBtn = await page.locator('button:has-text("Follow"), button[data-e2e="follow-button"]').first();
    if (await followBtn.isVisible()) {
      await followBtn.click();
      return true;
    }
    return false;
  }

  // --- 3. TẢI VIDEO TIKTOK KHÔNG DÍNH LOGO / WATERMARK ---
  async getLinkDownVideoWithoutLogo(tiktokUrl) {
    return new Promise((resolve, reject) => {
      // Free public TikWM API endpoint
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}`;
      https.get(apiUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 0 && json.data) {
              resolve({
                ok: true,
                title: json.data.title,
                author: json.data.author?.nickname,
                videoNoWatermark: json.data.play, // Direct MP4 without logo
                music: json.data.music,
                cover: json.data.cover
              });
            } else {
              resolve({ ok: false, error: json.msg || 'Không thể trích xuất video' });
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', err => reject(err));
    });
  }
}

module.exports = new TikTokService();
