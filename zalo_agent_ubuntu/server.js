const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');

const db = require('./db');
const zaloManager = require('./zaloManager');
const zaloAuto = require('./services/zaloAutomationService');
const facebookService = require('./services/facebookService');
const tiktokService = require('./services/tiktokService');
const aiService = require('./services/aiService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', message: 'Kết nối WebSocket thành công' }));
});

// --- ACCOUNTS API ---
app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare('SELECT id, name, avatar, zalo_id, is_active, created_at FROM accounts').all();
  const enriched = accounts.map(acc => ({
    ...acc,
    isConnected: zaloManager.activeApis.has(acc.id)
  }));
  res.json({ ok: true, data: enriched });
});

app.delete('/api/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  zaloManager.activeApis.delete(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  res.json({ ok: true, message: 'Đã xóa tài khoản' });
});

// --- QR LOGIN TRIGGER ---
app.post('/api/auth/qr', async (req, res) => {
  try {
    zaloManager.startQRLogin(broadcast).catch(err => {
      console.error('QR Login background error:', err);
    });
    res.json({ ok: true, message: 'Đã bắt đầu phiên quét QR' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- COOKIE LOGIN TRIGGER ---
app.post('/api/auth/cookie', async (req, res) => {
  const { cookie, imei, userAgent } = req.body;
  if (!cookie) return res.status(400).json({ ok: false, error: 'Vui lòng cung cấp Cookie từ chat.zalo.me' });

  try {
    const result = await zaloManager.loginWithCookie(cookie, imei, userAgent);
    broadcast({
      type: 'login_success',
      account: {
        id: result.accountId,
        name: result.displayName,
        avatar: result.avatarUrl,
        zalo_id: result.zaloId
      },
      message: `Đăng nhập thành công tài khoản: ${result.displayName}!`
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- CONTACTS & DATA SCAN API ---
app.get('/api/contacts', (req, res) => {
  const { account_id, is_friend, gender, search, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM contacts WHERE 1=1';
  const params = [];

  if (account_id) {
    sql += ' AND account_id = ?';
    params.push(account_id);
  }
  if (is_friend !== undefined && is_friend !== '') {
    sql += ' AND is_friend = ?';
    params.push(is_friend);
  }
  if (gender) {
    sql += ' AND gender = ?';
    params.push(gender);
  }
  if (search) {
    sql += ' AND (name LIKE ? OR zalo_name LIKE ? OR phone LIKE ? OR uid LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const countRow = db.prepare(countSql).get(...params);

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const items = db.prepare(sql).all(...params);
  res.json({ ok: true, items, total: countRow.total });
});

app.post('/api/scan/friends', async (req, res) => {
  const { account_id } = req.body;
  if (!account_id) return res.status(400).json({ ok: false, error: 'Thiếu account_id' });

  try {
    zaloManager.scanFriends(Number(account_id), broadcast).catch(err => {
      broadcast({ type: 'scan_error', error: err.message });
    });
    res.json({ ok: true, message: 'Đã bắt đầu quét danh bạ bạn bè' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint quét gợi ý kết bạn Native AES (friend-wpa.zaloapp.com/api/friend/recommendsv2/list)
app.post('/api/scan/recommends', async (req, res) => {
  const { account_id } = req.body;
  if (!account_id) return res.status(400).json({ ok: false, error: 'Thiếu account_id' });

  try {
    zaloManager.scanFriendRecommends(Number(account_id), broadcast).catch(err => {
      broadcast({ type: 'scan_error', error: err.message });
    });
    res.json({ ok: true, message: 'Đang quét danh sách gợi ý kết bạn (recommendsv2) qua Native AES' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GROUPS API ---
app.get('/api/groups', (req, res) => {
  const { account_id } = req.query;
  let sql = 'SELECT * FROM groups WHERE 1=1';
  const params = [];
  if (account_id) {
    sql += ' AND account_id = ?';
    params.push(account_id);
  }
  sql += ' ORDER BY member_count DESC';
  const items = db.prepare(sql).all(...params);
  res.json({ ok: true, items });
});

app.post('/api/scan/groups', async (req, res) => {
  const { account_id } = req.body;
  if (!account_id) return res.status(400).json({ ok: false, error: 'Thiếu account_id' });

  try {
    zaloManager.scanGroups(Number(account_id), broadcast).catch(err => {
      broadcast({ type: 'scan_error', error: err.message });
    });
    res.json({ ok: true, message: 'Đã bắt đầu quét danh sách nhóm' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GROUP MEMBERS API ---
app.get('/api/group-members/:groupId', (req, res) => {
  const members = db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY id ASC').all(req.params.groupId);
  res.json({ ok: true, items: members, total: members.length });
});

app.post('/api/scan/group-members', async (req, res) => {
  const { account_id, group_id, mode } = req.body;
  if (!account_id || !group_id) return res.status(400).json({ ok: false, error: 'Thiếu account_id hoặc group_id' });

  try {
    zaloManager.scanGroupMembers(Number(account_id), group_id, broadcast).catch(err => {
      broadcast({ type: 'scan_error', error: err.message });
    });
    res.json({ ok: true, message: 'Đang quét thành viên nhóm qua Zalo Protocol (bao gồm thành viên ẩn)' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint quét chuyên sâu thành viên ẩn (Thuần Protocol, không mở trình duyệt)
app.post('/api/scan/group-members-deep', async (req, res) => {
  const { account_id, group_id } = req.body;
  if (!account_id || !group_id) return res.status(400).json({ ok: false, error: 'Thiếu account_id hoặc group_id' });

  try {
    zaloManager.scanGroupMembers(Number(account_id), group_id, broadcast).catch(err => {
      broadcast({ type: 'scan_error', error: err.message });
    });
    res.json({ ok: true, message: 'Đang bóc tách toàn bộ thành viên nhóm (kể cả thành viên ẩn) qua Zalo Protocol' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- PHONE CHECK API ---
app.post('/api/phone-check', async (req, res) => {
  const { account_id, phones } = req.body;
  if (!account_id || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ ok: false, error: 'Thiếu account_id hoặc danh sách số điện thoại' });
  }

  try {
    zaloManager.checkPhoneNumbers(Number(account_id), phones, broadcast).catch(err => {
      broadcast({ type: 'phone_check_error', error: err.message });
    });
    res.json({ ok: true, message: `Đang kiểm tra ${phones.length} số điện thoại` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/phone-checks', (req, res) => {
  const items = db.prepare('SELECT * FROM phone_checks ORDER BY id DESC LIMIT 200').all();
  res.json({ ok: true, items });
});

// --- DATA GROUPS API ---
app.get('/api/data-groups', (req, res) => {
  const items = db.prepare(`
    SELECT dg.*, COUNT(dgi.contact_id) as member_count 
    FROM data_groups dg 
    LEFT JOIN data_group_items dgi ON dg.id = dgi.data_group_id 
    GROUP BY dg.id 
    ORDER BY dg.id DESC
  `).all();
  res.json({ ok: true, items });
});

app.post('/api/data-groups', (req, res) => {
  const { name, description, source, contact_type } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Tên nhóm không được để trống' });

  const stmt = db.prepare('INSERT INTO data_groups (name, description, source, contact_type) VALUES (?, ?, ?, ?)');
  const info = stmt.run(name, description || '', source || 'scan', contact_type || 'person');
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/data-groups/:id/add-contacts', (req, res) => {
  const groupId = req.params.id;
  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids)) return res.status(400).json({ ok: false, error: 'contact_ids phải là mảng' });

  const insert = db.prepare('INSERT OR IGNORE INTO data_group_items (data_group_id, contact_id) VALUES (?, ?)');
  db.transaction(() => {
    for (const cid of contact_ids) {
      insert.run(groupId, cid);
    }
  })();
  res.json({ ok: true, count: contact_ids.length });
});

// --- CAMPAIGNS API ---
app.get('/api/campaigns', (req, res) => {
  const items = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  res.json({ ok: true, items });
});

app.post('/api/campaigns', (req, res) => {
  const { name, account_id, type, template, delay_min, delay_max } = req.body;
  if (!name || !account_id || !template) {
    return res.status(400).json({ ok: false, error: 'Vui lòng nhập đủ thông tin chiến dịch' });
  }

  const stmt = db.prepare(`
    INSERT INTO campaigns (name, account_id, type, template, delay_min, delay_max)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, account_id, type || 'message_friends', template, delay_min || 5, delay_max || 15);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/campaigns/:id/start', async (req, res) => {
  const id = Number(req.params.id);
  try {
    zaloManager.runCampaign(id, broadcast).catch(err => {
      broadcast({ type: 'campaign_error', campaignId: id, error: err.message });
    });
    res.json({ ok: true, message: 'Đã khởi chạy chiến dịch' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/campaigns/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const stopped = zaloManager.stopCampaign(id);
  res.json({ ok: true, stopped });
});

app.get('/api/campaigns/:id/logs', (req, res) => {
  const logs = db.prepare('SELECT * FROM campaign_logs WHERE campaign_id = ? ORDER BY id DESC LIMIT 100').all(req.params.id);
  res.json({ ok: true, items: logs });
});

// --- EXTENDED ZALO AUTO API (56 ACTIONS) ---
app.post('/api/zalo/send-phone', async (req, res) => {
  const { account_id, phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'Thiếu phone hoặc message' });
  try {
    const r = await zaloAuto.sendMessageToPhoneZalo(Number(account_id) || 1, phone, message, broadcast);
    res.json({ ok: true, data: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/send-friend', async (req, res) => {
  const { account_id, uid, message } = req.body;
  try {
    const r = await zaloAuto.sendMessageToFriendZalo(Number(account_id) || 1, uid, message, broadcast);
    res.json({ ok: true, data: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Gửi tin nhắn qua phương thức Chia sẻ (Share Method) - Chuyên trị gửi cho thành viên nhóm bị ẩn / người lạ
app.post('/api/zalo/send-share-method', async (req, res) => {
  const { account_id, target, message } = req.body;
  if (!target || !message) return res.status(400).json({ ok: false, error: 'Thiếu target (UID/Tên) hoặc message' });
  try {
    const r = await zaloAuto.sendMessageToFriendByShareMethodZalo(Number(account_id) || 1, target, message, broadcast);
    res.json({ ok: true, data: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Gửi tin nhắn tuần tự từng người (SendEachOne Method)
app.post('/api/zalo/send-each-one', async (req, res) => {
  const { account_id, targets, message, delay_min, delay_max } = req.body;
  if (!Array.isArray(targets) || targets.length === 0 || !message) {
    return res.status(400).json({ ok: false, error: 'Thiếu danh sách targets hoặc message' });
  }
  try {
    zaloAuto.sendMessageToFriendBySendEachOneMethodZalo(
      Number(account_id) || 1,
      targets,
      message,
      { delayMin: Number(delay_min) || 8, delayMax: Number(delay_max) || 18 },
      broadcast
    ).catch(e => console.error(e));
    res.json({ ok: true, message: `Đã bắt đầu gửi tin nhắn tuần tự tới ${targets.length} người nhận!` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/send-group', async (req, res) => {
  const { account_id, group_id, message } = req.body;
  try {
    const r = await zaloAuto.sendMessageToGroupZalo(Number(account_id) || 1, group_id, message, broadcast);
    res.json({ ok: true, data: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/send-hpbd', async (req, res) => {
  const { account_id, template } = req.body;
  try {
    zaloAuto.sendMessageHpbdZalo(Number(account_id) || 1, template, broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: 'Đã bắt đầu quét và gửi chúc mừng sinh nhật bạn bè hôm nay!' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/add-friend', async (req, res) => {
  const { account_id, phone, greeting } = req.body;
  try {
    const r = await zaloAuto.addFriendZalo(Number(account_id) || 1, phone, greeting, broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/add-recommend', async (req, res) => {
  const { account_id, limit, greeting } = req.body;
  try {
    zaloAuto.addFriendsRecommendZalo(Number(account_id) || 1, Number(limit) || 10, greeting, broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: `Bắt đầu kết bạn gợi ý (tối đa ${limit || 10} người)` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/accept-friends', async (req, res) => {
  const { account_id, limit } = req.body;
  try {
    zaloAuto.acceptAddFriendsZalo(Number(account_id) || 1, Number(limit) || 20, broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: 'Bắt đầu tự động đồng ý lời mời kết bạn' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/join-group-link', async (req, res) => {
  const { account_id, link } = req.body;
  try {
    const r = await zaloAuto.joinGroupByLinkZalo(Number(account_id) || 1, link, broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/zalo/unread', async (req, res) => {
  const { account_id } = req.query;
  const r = await zaloAuto.countUnreadMessage(Number(account_id) || 1);
  res.json(r);
});

// --- ZCA-JS NATIVE PROTOCOL APIS (GROUPS, POLLS, AI CHATBOT) ---
app.post('/api/zalo/create-group', async (req, res) => {
  const { account_id = 1, name, member_uids = [] } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Thiếu tên nhóm Zalo' });
  try {
    const r = await zaloManager.createGroup(Number(account_id), name, member_uids);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/add-users-group', async (req, res) => {
  const { account_id = 1, group_id, member_uids } = req.body;
  if (!group_id || !member_uids) return res.status(400).json({ ok: false, error: 'Thiếu group_id hoặc member_uids' });
  try {
    const r = await zaloManager.addUsersToGroup(Number(account_id), group_id, member_uids);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/remove-user-group', async (req, res) => {
  const { account_id = 1, group_id, member_uid } = req.body;
  try {
    const r = await zaloManager.removeUserFromGroup(Number(account_id), group_id, member_uid);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/create-poll', async (req, res) => {
  const { account_id = 1, group_id, question, options } = req.body;
  if (!group_id || !question || !options) return res.status(400).json({ ok: false, error: 'Thiếu thông tin cuộc bình chọn' });
  try {
    const r = await zaloManager.createGroupPoll(Number(account_id), group_id, question, options);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/create-note', async (req, res) => {
  const { account_id = 1, group_id, content } = req.body;
  if (!group_id || !content) return res.status(400).json({ ok: false, error: 'Thiếu group_id hoặc nội dung ghi chú' });
  try {
    const r = await zaloManager.createGroupNote(Number(account_id), group_id, content);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ZALO REALTIME AI CHATBOT 24/7 (via zca-js listener)
app.post('/api/zalo/chatbot/start', (req, res) => {
  const { account_id = 1, tone = 'friendly', delay_sec = 2, custom_spintax } = req.body;
  try {
    const r = zaloManager.startChatbot(Number(account_id), { tone, replyDelaySec: delay_sec, customSpintax: custom_spintax }, broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/zalo/chatbot/stop', (req, res) => {
  const { account_id = 1 } = req.body;
  const r = zaloManager.stopChatbot(Number(account_id), broadcast);
  res.json(r);
});

// --- FACEBOOK AUTO API (>120 ACTIONS) ---
app.post('/api/facebook/login', async (req, res) => {
  const { account_id = 1 } = req.body;
  try {
    const r = await facebookService.openLogin(account_id);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/newsfeed', async (req, res) => {
  const { account_id = 1, minutes = 5, like_rate = 0.4 } = req.body;
  try {
    facebookService.newsfeedFb(account_id, Number(minutes), Number(like_rate), broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: `Đã khởi động nuôi nick lướt Newsfeed Facebook trong ${minutes} phút!` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/post-profile', async (req, res) => {
  const { account_id = 1, content } = req.body;
  try {
    const r = await facebookService.postToMyProfileFb(account_id, content, '', broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/post-group', async (req, res) => {
  const { account_id = 1, group_id, content } = req.body;
  try {
    const r = await facebookService.postToGroupFb(account_id, group_id, content, broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/add-recommend', async (req, res) => {
  const { account_id = 1, limit = 10 } = req.body;
  try {
    facebookService.addFriendsRecommendFb(account_id, Number(limit), broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: `Đang kết bạn gợi ý Facebook (${limit} người)...` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/accept-friends', async (req, res) => {
  const { account_id = 1, limit = 20 } = req.body;
  try {
    facebookService.acceptAddFriendsFb(account_id, Number(limit), broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: 'Đang tự động đồng ý kết bạn Facebook...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/scan-comments', async (req, res) => {
  const { account_id = 1, post_url } = req.body;
  try {
    const r = await facebookService.loadUidCmtFromPost(account_id, post_url, broadcast);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- TIKTOK AUTO API (41 ACTIONS) ---
app.post('/api/tiktok/login', async (req, res) => {
  const { account_id = 1 } = req.body;
  try {
    const r = await tiktokService.openLogin(account_id);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tiktok/surf', async (req, res) => {
  const { account_id = 1, minutes = 5, interact_rate = 0.5 } = req.body;
  try {
    tiktokService.surfingTikTok(account_id, Number(minutes), Number(interact_rate), broadcast).catch(e => console.error(e));
    res.json({ ok: true, message: `Bắt đầu lướt For You feed TikTok trong ${minutes} phút!` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tiktok/download-no-watermark', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'Thiếu link TikTok' });
  try {
    const r = await tiktokService.getLinkDownVideoWithoutLogo(url);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- AI SERVICE API (14 ACTIONS) ---
app.post('/api/ai/check-post', (req, res) => {
  const { content } = req.body;
  res.json(aiService.checkPost(content));
});

app.post('/api/ai/check-comment', (req, res) => {
  const { comment } = req.body;
  res.json(aiService.checkCmt(comment));
});

app.post('/api/ai/write-comment', (req, res) => {
  const { content, tone = 'friendly' } = req.body;
  res.json(aiService.writeCmt(content, tone));
});

app.post('/api/ai/write-reply', (req, res) => {
  const { comment, product_info = '' } = req.body;
  res.json(aiService.writeReplyCmt(comment, product_info));
});

app.post('/api/ai/write-message', (req, res) => {
  const { topic, recipient_name = 'bạn' } = req.body;
  res.json(aiService.writeMessageForPost(topic, recipient_name));
});

// --- EXCEL EXPORT ---
app.get('/api/export/contacts', (req, res) => {
  const contacts = db.prepare('SELECT uid, name, zalo_name, phone, gender, is_friend, updated_at FROM contacts').all();
  const ws = XLSX.utils.json_to_sheet(contacts);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="zalo_contacts.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.get('/api/export/groups', (req, res) => {
  const groups = db.prepare('SELECT group_id, name, member_count, is_joined, updated_at FROM groups ORDER BY member_count DESC').all();
  const ws = XLSX.utils.json_to_sheet(groups);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Groups');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="zalo_groups.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.get('/api/export/phones', (req, res) => {
  const checks = db.prepare('SELECT phone, has_zalo, zalo_name, zalo_id, status, checked_at FROM phone_checks').all();
  const ws = XLSX.utils.json_to_sheet(checks);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Phone_Checks');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="phone_checks.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 Zalo Agent Ubuntu Server running at: http://localhost:${PORT}`);
  await zaloManager.init();
});
