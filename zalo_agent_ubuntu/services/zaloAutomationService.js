const browserManager = require('./browserManager');
const zaloProtocol = require('../zaloManager');
const db = require('../db');
const { renderMessage } = require('../spintax');

class ZaloAutomationService {
  // --- 1. ĐĂNG NHẬP & TRẠNG THÁI ---
  async loginZalo(accountId, visible = true) {
    const page = await browserManager.launchBrowser('zalo', accountId, { headless: !visible });
    await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
    return { ok: true, message: 'Đã mở cửa sổ Zalo Web Chrome. Vui lòng đăng nhập hoặc đợi khôi phục phiên.' };
  }

  async checkLoginStatusZalo(accountId) {
    try {
      const page = await browserManager.launchBrowser('zalo', accountId, { headless: true });
      if (!page.url().includes('chat.zalo.me')) {
        await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
        await browserManager.humanDelay(2, 3);
      }
      const isLoggedIn = await page.evaluate(() => {
        return !!(document.querySelector('#main-tab') || document.querySelector('.nav__tabs') || document.querySelector('#contact-search-input'));
      });
      return { ok: true, isLoggedIn };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async refreshZaloPage(accountId) {
    const page = await browserManager.launchBrowser('zalo', accountId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    return { ok: true, message: 'Đã tải lại trang Zalo Web.' };
  }

  async countUnreadMessage(accountId) {
    const page = await browserManager.launchBrowser('zalo', accountId);
    const unread = await page.evaluate(() => {
      const badges = document.querySelectorAll('.unread-badge, .nav__item-badge, .tab-badge');
      let count = 0;
      badges.forEach(b => {
        const n = parseInt(b.innerText.trim(), 10);
        if (!isNaN(n)) count += n;
      });
      return count;
    });
    return { ok: true, unreadCount: unread };
  }

  // --- 2. GỬI TIN NHẮN TỰ ĐỘNG ---
  async sendMessageToPhoneZalo(accountId, phone, messageText, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('zalo', accountId);
    broadcast({ type: 'task_log', message: `Đang tìm kiếm số điện thoại ${phone} trên Zalo...` });

    await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(2, 4);

    const searchInput = await page.waitForSelector('#contact-search-input', { timeout: 10000 });
    await searchInput.click();
    await searchInput.fill(phone);
    await browserManager.humanDelay(1, 2);
    await page.keyboard.press('Enter');
    await browserManager.humanDelay(2, 3);

    // Render spintax
    const finalMsg = renderMessage(messageText, { phone, name: phone });

    // Focus input chat box
    const chatInput = await page.waitForSelector('#richInput, div[contenteditable="true"]', { timeout: 8000 });
    await chatInput.click();
    await page.keyboard.type(finalMsg, { delay: 35 });
    await browserManager.humanDelay(1, 2);
    await page.keyboard.press('Enter');

    broadcast({ type: 'task_log', message: `✅ Đã gửi tin thành công tới SĐT ${phone}!` });
    return { ok: true, phone, message: finalMsg };
  }

  async sendMessageToFriendZalo(accountId, uidOrName, messageText, broadcast = () => {}) {
    // Try ultra-fast Protocol Engine first if connected (for friends / contacts)
    try {
      const api = zaloProtocol.getApi(accountId);
      const finalMsg = renderMessage(messageText, { uid: uidOrName, name: uidOrName });
      await api.sendMessage(finalMsg, uidOrName);
      broadcast({ type: 'task_log', message: `✅ (Protocol) Đã gửi tin nhắn tới ${uidOrName}` });
      return { ok: true, mode: 'protocol', target: uidOrName };
    } catch (err) {
      // Fallback to Share Method (Kỹ thuật Forward tin nhắn qua Cloud của tôi - cho phép gửi tin nhắn tới người lạ / thành viên nhóm bị ẩn mà không bị Zalo chặn)
      broadcast({ type: 'task_log', message: `Không thể gửi trực tiếp qua API (${err.message}). Tự động chuyển sang kỹ thuật Chia sẻ (Share Method)...` });
      return await this.sendMessageToFriendByShareMethodZalo(accountId, uidOrName, messageText, broadcast);
    }
  }

  // --- KỸ THUẬT GỬI TIN NHẮN CHIA SẺ (SHARE METHOD - LÕI AKABIZ GỐC) ---
  // Cho phép gửi tin nhắn tới thành viên nhóm bị ẩn / người lạ chưa kết bạn mà KHÔNG BỊ ZALO CHẶN
  async sendMessageToFriendByShareMethodZalo(accountId, targetUidOrName, messageText, broadcast = () => {}) {
    broadcast({ type: 'task_log', message: `🔄 (Share Method Protocol) Chuẩn bị chuyển tiếp tin nhắn tới: ${targetUidOrName}...` });
    try {
      return await zaloProtocol.sendMessageProtocol(accountId, targetUidOrName, messageText, broadcast);
    } catch (protoErr) {
      broadcast({ type: 'task_log', message: `⚠️ Lỗi gửi tin tới ${targetUidOrName}: ${protoErr.message}` });
      throw protoErr;
    }
  }

  // --- KỸ THUẬT GỬI TUẦN TỰ TỪNG NGƯỜI (SEND EACH ONE METHOD) ---
  async sendMessageToFriendBySendEachOneMethodZalo(accountId, targetList, messageText, options = {}, broadcast = () => {}) {
    const delayMin = options.delayMin || 8;
    const delayMax = options.delayMax || 18;
    const total = targetList.length;
    let sentCount = 0;
    let failedCount = 0;

    broadcast({ type: 'task_log', message: `🚀 Bắt đầu gửi tin nhắn tuần tự (SendEachOne Method) tới ${total} người nhận...` });

    for (let i = 0; i < total; i++) {
      const target = targetList[i];
      const targetName = typeof target === 'string' ? target : (target.name || target.uid);
      broadcast({ type: 'task_log', message: `[${i + 1}/${total}] Đang gửi tin tới ${targetName}...` });

      try {
        await this.sendMessageToFriendByShareMethodZalo(accountId, targetName, messageText, broadcast);
        sentCount++;
      } catch (err) {
        failedCount++;
        broadcast({ type: 'task_log', message: `⚠️ [${i + 1}/${total}] Lỗi gửi tới ${targetName}: ${err.message}` });
      }

      if (i < total - 1) {
        const waitSec = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
        broadcast({ type: 'task_log', message: `⏳ Tạm nghỉ an toàn ${waitSec} giây trước khi gửi người tiếp theo...` });
        await new Promise(r => setTimeout(r, waitSec * 1000));
      }
    }

    broadcast({ type: 'task_log', message: `🏁 Hoàn thành chiến dịch gửi tin: ${sentCount} thành công, ${failedCount} thất bại!` });
    return { ok: true, total, sentCount, failedCount };
  }

  async sendMessageToGroupZalo(accountId, groupId, messageText, broadcast = () => {}) {
    try {
      const api = zaloProtocol.getApi(accountId);
      const finalMsg = renderMessage(messageText, { group: groupId });
      await api.sendMessage(finalMsg, groupId);
      broadcast({ type: 'task_log', message: `✅ Đã gửi tin vào nhóm ${groupId}` });
      return { ok: true, groupId };
    } catch (err) {
      // Fallback to browser
      const page = await browserManager.launchBrowser('zalo', accountId);
      await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
      await browserManager.humanDelay(2, 3);

      const searchInput = await page.waitForSelector('#contact-search-input', { timeout: 10000 });
      await searchInput.fill(groupId);
      await page.keyboard.press('Enter');
      await browserManager.humanDelay(2, 3);

      const chatInput = await page.waitForSelector('#richInput, div[contenteditable="true"]', { timeout: 8000 });
      await chatInput.click();
      await page.keyboard.type(renderMessage(messageText), { delay: 30 });
      await page.keyboard.press('Enter');
      return { ok: true, groupId };
    }
  }

  async sendMessageHpbdZalo(accountId, template = '{Chúc mừng sinh nhật|Happy Birthday} [name]! {Chúc bạn tuổi mới nhiều may mắn, thành công và dồi dào sức khỏe nhé! 🎉🎂|Chúc bạn một ngày sinh nhật thật ý nghĩa và tràn đầy niềm vui! 🎁✨}', broadcast = () => {}) {
    broadcast({ type: 'task_log', message: 'Đang kiểm tra danh sách bạn bè có sinh nhật hôm nay...' });
    const today = new Date();
    const curDay = today.getDate();
    const curMonth = today.getMonth() + 1;

    // Check contacts in DB
    const friends = db.prepare('SELECT uid, name, extra_data FROM contacts WHERE account_id = ? AND is_friend = 1').all(accountId);
    let sentCount = 0;

    for (const f of friends) {
      let isBirthday = false;
      if (f.extra_data) {
        try {
          const extra = JSON.parse(f.extra_data);
          if (extra.dob) {
            const d = new Date(extra.dob);
            if (d.getDate() === curDay && (d.getMonth() + 1) === curMonth) {
              isBirthday = true;
            }
          }
        } catch (e) {}
      }

      if (isBirthday) {
        broadcast({ type: 'task_log', message: `🎉 Tìm thấy bạn bè sinh nhật hôm nay: ${f.name} (${f.uid})` });
        const msg = renderMessage(template, { name: f.name });
        await this.sendMessageToFriendZalo(accountId, f.uid, msg, broadcast);
        sentCount++;
        await browserManager.humanDelay(4, 8);
      }
    }

    broadcast({ type: 'task_log', message: `Hoàn thành gửi chúc mừng sinh nhật: ${sentCount} bạn bè!` });
    return { ok: true, sentCount };
  }

  async dropFile(accountId, target, filePath, broadcast = () => {}) {
    try {
      broadcast({ type: 'task_log', message: `(Protocol) Đang tải file lên Zalo CDN và gửi tới ${target}: ${filePath}...` });
      const res = await zaloProtocol.sendAttachment(accountId, target, filePath, false);
      broadcast({ type: 'task_log', message: `✅ (Protocol) Đã gửi file thành công tới ${target}!` });
      return res;
    } catch (err) {
      // Fallback to browser
      broadcast({ type: 'task_log', message: `Dùng Chrome gửi file tới ${target}...` });
      const page = await browserManager.launchBrowser('zalo', accountId);
      await this.sendMessageToPhoneZalo(accountId, target, '', broadcast);
      const fileChooserPromise = page.waitForEvent('filechooser');
      const attachBtn = await page.waitForSelector('i[class*="attach"], [title*="Gửi file"], [title*="Gửi hình ảnh"]');
      await attachBtn.click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePath);
      await browserManager.humanDelay(2, 4);
      await page.keyboard.press('Enter');

      broadcast({ type: 'task_log', message: `✅ Đã gửi file thành công tới ${target}!` });
      return { ok: true, filePath };
    }
  }

  // --- 3. TƯƠNG TÁC & KẾT BẠN (SIÊU TỐC PROTOCOL NATIVE) ---
  async addFriendZalo(accountId, phone, greeting = '{Chào bạn|Xin chào}, {mình muốn kết bạn giao lưu cùng bạn!|rất vui được làm quen với bạn nhé!}', broadcast = () => {}) {
    try {
      broadcast({ type: 'task_log', message: `⚡ (Protocol) Đang tìm kiếm SĐT ${phone} và gửi lời mời kết bạn...` });
      const res = await zaloProtocol.sendFriendRequestByPhone(accountId, phone, greeting);
      broadcast({ type: 'task_log', message: `✅ (Protocol) Đã gửi lời mời kết bạn thành công tới ${res.user.displayName || phone} (${res.user.uid})!` });
      return res;
    } catch (err) {
      // Fallback to Chrome Automation if needed
      broadcast({ type: 'task_log', message: `Chuyển sang Chrome Automation kết bạn cho ${phone}: ${err.message}` });
      const page = await browserManager.launchBrowser('zalo', accountId);
      await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
      await browserManager.humanDelay(2, 3);

      const searchInput = await page.waitForSelector('#contact-search-input', { timeout: 10000 });
      await searchInput.fill(phone);
      await page.keyboard.press('Enter');
      await browserManager.humanDelay(2, 4);

      const addBtn = await page.locator('button:has-text("Kết bạn"), div[role="button"]:has-text("Kết bạn")').first();
      if (await addBtn.isVisible()) {
        await addBtn.click();
        await browserManager.humanDelay(1, 2);

        const greetingInput = await page.locator('textarea, input[placeholder*="lời chào"]').first();
        if (await greetingInput.isVisible()) {
          const msg = renderMessage(greeting, { phone });
          await greetingInput.fill(msg);
        }

        const confirmBtn = await page.locator('button:has-text("Gửi yêu cầu"), button:has-text("Kết bạn")').last();
        if (await confirmBtn.isVisible()) {
          await confirmBtn.click();
        }

        broadcast({ type: 'task_log', message: `✅ Đã gửi lời mời kết bạn tới SĐT ${phone}!` });
        return { ok: true, phone, status: 'request_sent' };
      } else {
        broadcast({ type: 'task_log', message: `Đã là bạn bè hoặc không tìm thấy nút kết bạn cho SĐT ${phone}` });
        return { ok: false, reason: 'already_friend_or_not_found' };
      }
    }
  }

  async addFriendsRecommendZalo(accountId, limit = 10, greeting = '', broadcast = () => {}) {
    try {
      broadcast({ type: 'task_log', message: `⚡ (Protocol) Đang lấy danh sách gợi ý kết bạn từ Zalo server...` });
      const rec = await zaloProtocol.getRecommendations(accountId);
      const list = (rec && (rec.recommendations || rec.users || [])) || [];

      if (list.length > 0) {
        let sent = 0;
        for (const user of list) {
          if (sent >= limit) break;
          const uid = user.userId || user.uid || user.id;
          try {
            await zaloProtocol.getApi(accountId).sendFriendRequest(renderMessage(greeting || 'Chào bạn, kết bạn với mình nhé!'), uid);
            sent++;
            broadcast({ type: 'task_log', message: `[${sent}/${limit}] Đã gửi lời mời kết bạn tới ${user.displayName || uid}!` });
            await new Promise(r => setTimeout(r, 2000)); // Natural delay
          } catch (e) {
            console.warn('Friend request error for uid', uid, e.message);
          }
        }
        return { ok: true, count: sent };
      }
    } catch (e) {
      console.warn('Protocol recommendation failed, fallback to browser:', e.message);
    }

    // Fallback to browser
    const page = await browserManager.launchBrowser('zalo', accountId);
    broadcast({ type: 'task_log', message: `Mở danh sách Gợi ý kết bạn trên Chrome (mục tiêu: ${limit} người)...` });

    await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(2, 4);

    const contactTab = await page.locator('div[title*="Danh bạ"], div[data-id*="contact"]').first();
    if (await contactTab.isVisible()) {
      await contactTab.click();
      await browserManager.humanDelay(2, 3);
    }

    let count = 0;
    const addButtons = await page.locator('button:has-text("Kết bạn")').all();
    for (const btn of addButtons) {
      if (count >= limit) break;
      try {
        if (await btn.isVisible()) {
          await btn.click();
          count++;
          broadcast({ type: 'task_log', message: `[${count}/${limit}] Đã bấm kết bạn gợi ý!` });
          await browserManager.humanDelay(3, 6);
        }
      } catch (e) {}
    }

    broadcast({ type: 'task_log', message: `Hoàn tất kết bạn gợi ý: đã gửi ${count} lời mời!` });
    return { ok: true, count };
  }

  async acceptAddFriendsZalo(accountId, limit = 20, broadcast = () => {}) {
    const page = await browserManager.launchBrowser('zalo', accountId);
    broadcast({ type: 'task_log', message: `Mở danh sách lời mời kết bạn để đồng ý tự động...` });

    await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
    await browserManager.humanDelay(2, 4);

    let count = 0;
    const acceptBtns = await page.locator('button:has-text("Đồng ý"), button:has-text("Chấp nhận")').all();
    for (const btn of acceptBtns) {
      if (count >= limit) break;
      try {
        if (await btn.isVisible()) {
          await btn.click();
          count++;
          broadcast({ type: 'task_log', message: `[${count}/${limit}] Đã đồng ý kết bạn!` });
          await browserManager.humanDelay(2, 4);
        }
      } catch (e) {}
    }

    broadcast({ type: 'task_log', message: `Hoàn tất đồng ý kết bạn: ${count} lời mời!` });
    return { ok: true, count };
  }

  async cancelRequestAddFriendsZalo(accountId, broadcast = () => {}) {
    try {
      broadcast({ type: 'task_log', message: `⚡ (Protocol) Đang lấy danh sách lời mời đã gửi...` });
      const sent = await zaloProtocol.getSentFriendRequests(accountId);
      const list = (sent && (sent.users || sent.data || [])) || [];
      let count = 0;
      for (const u of list) {
        const uid = u.userId || u.uid || u.id;
        try {
          await zaloProtocol.undoFriendRequest(accountId, uid);
          count++;
          broadcast({ type: 'task_log', message: `Đã thu hồi lời mời kết bạn tới ${u.displayName || uid}` });
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {}
      }
      return { ok: true, count };
    } catch (e) {
      // Fallback
      return { ok: false, error: e.message };
    }
  }

  async joinGroupByLinkZalo(accountId, link, broadcast = () => {}) {
    try {
      broadcast({ type: 'task_log', message: `⚡ (Protocol) Tham gia nhóm qua link: ${link}...` });
      const res = await zaloProtocol.joinGroupByLink(accountId, link);
      broadcast({ type: 'task_log', message: `✅ (Protocol) Đã tham gia nhóm thành công!` });
      return res;
    } catch (e) {
      // Fallback to browser
      broadcast({ type: 'task_log', message: `Dùng Chrome tham gia nhóm: ${e.message}` });
      const page = await browserManager.launchBrowser('zalo', accountId);
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      await browserManager.humanDelay(2, 4);

      const joinBtn = await page.locator('button:has-text("Tham gia nhóm"), a:has-text("Tham gia nhóm")').first();
      if (await joinBtn.isVisible()) {
        await joinBtn.click();
        broadcast({ type: 'task_log', message: `✅ Đã gửi yêu cầu tham gia nhóm qua link!` });
        return { ok: true, status: 'joined_or_requested' };
      } else {
        return { ok: false, reason: 'not_found' };
      }
    }
  }

  // --- 4. QUÉT THÔNG TIN CHUYÊN SÂU (SCRAPER - LÕI AKABIZ GỐC) ---
  async loadFriendZalo(accountId, broadcast) {
    return await zaloProtocol.scanFriends(accountId, broadcast);
  }

  async loadGroupZalo(accountId, broadcast) {
    return await zaloProtocol.scanGroups(accountId, broadcast);
  }

  // Mở danh sách thành viên nhóm trên Chrome Zalo Web (akaBiz: OpenGroupMemberList)
  async openGroupMemberList(page, groupNameOrId, broadcast = () => {}) {
    broadcast({ type: 'task_log', message: `🔍 (OpenGroupMemberList) Đang mở danh sách thành viên nhóm: ${groupNameOrId}...` });

    if (!page.url().includes('chat.zalo.me')) {
      await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded' });
      await browserManager.humanDelay(2, 3);
    }

    // 1. Tìm nhóm bằng ô Search
    try {
      const searchInput = await page.waitForSelector('#contact-search-input', { timeout: 10000 });
      await searchInput.click();
      await searchInput.fill(groupNameOrId);
      await browserManager.humanDelay(1, 2);

      // Click vào kết quả nhóm đầu tiên
      const groupItem = page.locator('div[data-id*="conv_"], .conv-item, div:has-text("' + groupNameOrId + '")').first();
      if (await groupItem.isVisible()) {
        await groupItem.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await browserManager.humanDelay(2, 3);
    } catch (e) {
      console.warn('Group search warning:', e.message);
    }

    // 2. Click vào icon "Thông tin hội thoại" (Sidebar bên phải nhóm)
    broadcast({ type: 'task_log', message: `Mở bảng thông tin hội thoại nhóm...` });
    try {
      const infoBtn = page.locator('[title*="Thông tin hội thoại"], [data-id="btn_chat_info"], .chat-info-general, div[title="Thông tin hội thoại"]').first();
      if (await infoBtn.isVisible()) {
        await infoBtn.click();
        await browserManager.humanDelay(1, 2);
      }
    } catch (e) {
      console.warn('Info button warning:', e.message);
    }

    // 3. Click vào mục "Xem tất cả thành viên" / "Thành viên (xxx)"
    broadcast({ type: 'task_log', message: `Mở danh sách toàn bộ thành viên nhóm...` });
    try {
      const memberListBtn = page.locator('div[data-id="div_grp_info_mem"], div:has-text("Xem tất cả thành viên"), div:has-text("Thành viên ("), [data-translate-inner="STR_VIEW_ALL_MEMBER"]').first();
      if (await memberListBtn.isVisible()) {
        await memberListBtn.click();
        await browserManager.humanDelay(1, 2);
      }
    } catch (e) {
      console.warn('Member list button warning:', e.message);
    }

    return true;
  }

  // Quét danh sách thành viên nhóm chuyên sâu - BAO GỒM CẢ THÀNH VIÊN BỊ ẨN (Thuần Protocol API, không mở trình duyệt)
  async loadGroupMemberZalo(accountId, groupId, broadcast = () => {}, useDeepScan = true) {
    return await zaloProtocol.scanGroupMembers(accountId, groupId, broadcast);
  }

  // Trích xuất thông tin cá nhân trong Profile (akaBiz: GetNameInProfile, GetGenderInProfile, GetInfoContactInProfile, GetAvatarLinkInProfile)
  async getNameInProfile(page) {
    return await page.evaluate(() => {
      const el = document.querySelector('.profile-name, [data-id="lbl_ProfileName"], .user-title');
      return el ? el.innerText.trim() : '';
    });
  }

  async getGenderInProfile(page) {
    return await page.evaluate(() => {
      const el = document.querySelector('.profile-gender, [data-id="lbl_ProfileGender"], span:has-text("Giới tính")');
      return el ? el.innerText.trim() : 'Không rõ';
    });
  }

  async getInfoContactInProfile(page) {
    return await page.evaluate(() => {
      const el = document.querySelector('.profile-phone, [data-id="lbl_ProfilePhone"], .phone-number');
      return el ? el.innerText.trim() : '';
    });
  }

  async getAvatarLinkInProfile(page) {
    return await page.evaluate(() => {
      const el = document.querySelector('.profile-avatar img, [data-id="img_ProfileAvatar"]');
      return el ? el.src : '';
    });
  }

  async getProfileInfo(accountId, uid) {
    try {
      const api = zaloProtocol.getApi(accountId);
      const info = await api.getUserInfo(uid);
      return { ok: true, data: info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = new ZaloAutomationService();
