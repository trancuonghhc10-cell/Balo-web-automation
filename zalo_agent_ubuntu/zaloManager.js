const { Zalo, LoginQRCallbackEventType } = require('zca-js');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('./db');
const { renderMessage } = require('./spintax');
const {
  buildCookie,
  aesEncrypt,
  aesDecrypt,
  getProfiles,
  getFriendRecommends
} = require('./zaloProtocolHelper');

async function fetchNativeGroupMembers(api, uids) {
  return await getProfiles(api, uids);
}

function convertCookieInput(input) {
  if (!input) return [];
  let cookies = [];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        cookies = Array.isArray(parsed) ? parsed : (parsed.cookies || [parsed]);
      } catch (e) {}
    }
    if (cookies.length === 0) {
      // Parse standard cookie string: "name=value; name2=value2"
      const parts = trimmed.split(';');
      for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx !== -1) {
          const name = part.slice(0, idx).trim();
          const value = part.slice(idx + 1).trim();
          if (name) {
            cookies.push({
              name,
              key: name,
              value,
              domain: 'chat.zalo.me',
              path: '/'
            });
          }
        }
      }
    }
  } else if (Array.isArray(input)) {
    cookies = input;
  } else if (input && input.cookies) {
    cookies = input.cookies;
  }

  // Ensure critical session cookies exist for both chat.zalo.me and zaloapp.com
  const expanded = [];
  for (const c of cookies) {
    expanded.push(c);
    const key = c.name || c.key;
    if (['zpw_sek', 'zpsid', '__zi'].includes(key)) {
      expanded.push({ ...c, domain: 'zaloapp.com' });
      expanded.push({ ...c, domain: 'zalo.me' });
      expanded.push({ ...c, domain: 'chat.zalo.me' });
    }
  }
  return expanded;
}

class ZaloManager {
  constructor() {
    this.activeApis = new Map(); // accountId -> API instance
    this.activeCampaigns = new Set(); // campaignIds currently running
  }

  // Load all active accounts from DB on startup
  async init() {
    const rows = db.prepare('SELECT * FROM accounts WHERE is_active = 1').all();
    console.log(`📦 Found ${rows.length} saved Zalo accounts in database.`);
    for (const row of rows) {
      try {
        await this.loginFromSaved(row);
        console.log(`✅ Loaded session for account: ${row.name} (${row.zalo_id || row.id})`);
      } catch (err) {
        console.error(`⚠️ Failed to restore session for account ${row.name}:`, err.message);
      }
    }
  }

  async loginFromSaved(accountRow) {
    try {
      const cookieData = JSON.parse(accountRow.cookie);
      const zalo = new Zalo();
      const api = await zalo.login({
        imei: accountRow.imei || '',
        cookie: cookieData,
        userAgent: accountRow.user_agent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      });
      this.activeApis.set(accountRow.id, api);
      return api;
    } catch (err) {
      throw err;
    }
  }

  getApi(accountId) {
    const api = this.activeApis.get(Number(accountId));
    if (!api) {
      throw new Error(`Tài khoản ID ${accountId} chưa đăng nhập hoặc phiên đã hết hạn. Vui lòng bấm 'Thêm tài khoản' và quét mã QR để kích hoạt phiên mới.`);
    }
    return api;
  }

  // Direct login with cookies copied from chat.zalo.me
  async loginWithCookie(cookieInput, imei = '', userAgent = '') {
    const cookies = convertCookieInput(cookieInput);
    if (!cookies || cookies.length === 0) {
      throw new Error('Định dạng Cookie không hợp lệ. Vui lòng cung cấp chuỗi cookie hoặc mảng JSON cookie.');
    }

    const finalUserAgent = userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
    const zalo = new Zalo();
    const api = await zalo.login({
      imei: imei || '',
      cookie: cookies,
      userAgent: finalUserAgent
    });

    let accountInfo = null;
    try {
      accountInfo = await api.fetchAccountInfo();
    } catch (e) {
      console.warn('Could not fetch account info:', e.message);
    }

    const context = api.getContext();
    const zaloId = (accountInfo && (accountInfo.userId || accountInfo.id)) || (context && context.userId) || 'zalo_' + Date.now();
    const displayName = (accountInfo && (accountInfo.displayName || accountInfo.name)) || 'Tài khoản Zalo';
    const avatarUrl = accountInfo && accountInfo.avatar;

    // Save or update account in DB
    const existing = db.prepare('SELECT id FROM accounts WHERE zalo_id = ?').get(zaloId);
    let accountId;
    if (existing) {
      accountId = existing.id;
      db.prepare(`
        UPDATE accounts 
        SET name = ?, avatar = ?, cookie = ?, imei = ?, user_agent = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(displayName, avatarUrl, JSON.stringify(cookies), imei, finalUserAgent, accountId);
    } else {
      const res = db.prepare(`
        INSERT INTO accounts (name, avatar, zalo_id, imei, cookie, user_agent, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(displayName, avatarUrl, zaloId, imei, JSON.stringify(cookies), finalUserAgent);
      accountId = res.lastInsertRowid;
    }

    this.activeApis.set(accountId, api);
    return { accountId, displayName, zaloId, avatarUrl };
  }

  // Start QR Login session with realtime WebSocket callback
  async startQRLogin(broadcast) {
    const zalo = new Zalo();
    let currentActions = null;
    let isSessionCompleted = false;
    let expireRetries = 0;
    const maxRetries = 5;

    broadcast({ type: 'qr_status', status: 'initializing', message: 'Đang kết nối tới máy chủ Zalo Web (https://chat.zalo.me/)...' });

    try {
      const api = await zalo.loginQR(
        {
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        async (event) => {
          if (isSessionCompleted) return;
          currentActions = event.actions;

          if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
            let rawImage = event.data?.image || '';
            let qrDataUrl = '';

            // Ensure proper data URL format from official Zalo server image
            if (rawImage.startsWith('data:')) {
              qrDataUrl = rawImage;
            } else if (rawImage.length > 50) {
              qrDataUrl = `data:image/png;base64,${rawImage}`;
            } else if (event.data?.code) {
              // Fallback
              qrDataUrl = await QRCode.toDataURL(event.data.code, { width: 280, margin: 2 });
            }

            broadcast({
              type: 'qr_generated',
              qrImage: qrDataUrl,
              code: event.data?.code,
              message: 'Vui lòng mở ứng dụng Zalo trên điện thoại và quét mã QR'
            });
          } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
            broadcast({
              type: 'qr_scanned',
              avatar: event.data?.avatar,
              name: event.data?.display_name,
              message: `Đã quét QR bởi ${event.data?.display_name || 'người dùng'}. Vui lòng bấm 'Đăng nhập' trên điện thoại!`
            });
          } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
            if (isSessionCompleted) return;
            expireRetries++;
            if (expireRetries > maxRetries) {
              broadcast({
                type: 'qr_expired',
                message: 'Phiên quét QR đã kết thúc. Vui lòng bấm tạo mã mới nếu muốn đăng nhập.'
              });
              return;
            }
            broadcast({
              type: 'qr_expired',
              message: 'Mã QR đã hết hạn. Đang tạo mã mới từ Zalo Web...'
            });
            if (currentActions && currentActions.retry) {
              currentActions.retry();
            }
          } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
            isSessionCompleted = true;
            broadcast({
              type: 'qr_declined',
              message: 'Bạn đã từ chối đăng nhập trên điện thoại.'
            });
          } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
            isSessionCompleted = true;
            broadcast({
              type: 'qr_got_info',
              message: 'Đã nhận thông tin xác thực. Đang đồng bộ phiên làm việc...'
            });
          }
        }
      );

      isSessionCompleted = true;

      // Once loginQR resolves, we have the API instance
      let accountInfo = null;
      try {
        accountInfo = await api.fetchAccountInfo();
      } catch (e) {
        console.warn('Could not fetch account info right after login:', e.message);
      }

      const cookieData = await api.getCookie();
      const context = api.getContext();
      const zaloId = (accountInfo && (accountInfo.userId || accountInfo.id)) || (context && context.userId) || 'zalo_' + Date.now();
      const displayName = (accountInfo && (accountInfo.displayName || accountInfo.name)) || 'Tài khoản Zalo';
      const avatarUrl = accountInfo && accountInfo.avatar;

      // Save or update account in DB
      const existing = db.prepare('SELECT id FROM accounts WHERE zalo_id = ?').get(zaloId);
      let accountId;
      if (existing) {
        accountId = existing.id;
        db.prepare(`
          UPDATE accounts 
          SET name = ?, avatar = ?, cookie = ?, imei = ?, user_agent = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(displayName, avatarUrl, JSON.stringify(cookieData), context?.imei || '', context?.userAgent || '', accountId);
      } else {
        const res = db.prepare(`
          INSERT INTO accounts (name, avatar, zalo_id, imei, cookie, user_agent, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(displayName, avatarUrl, zaloId, context?.imei || '', JSON.stringify(cookieData), context?.userAgent || '');
        accountId = res.lastInsertRowid;
      }

      this.activeApis.set(accountId, api);

      broadcast({
        type: 'login_success',
        account: {
          id: accountId,
          name: displayName,
          avatar: avatarUrl,
          zalo_id: zaloId
        },
        message: `Đăng nhập thành công tài khoản: ${displayName}!`
      });

      return { accountId, displayName, zaloId };
    } catch (err) {
      broadcast({
        type: 'login_error',
        message: `Lỗi đăng nhập: ${err.message}`
      });
      throw err;
    }
  }

  // Scan all friends
  async scanFriends(accountId, broadcast = () => {}) {
    const api = this.getApi(accountId);
    broadcast({ type: 'scan_progress', phase: 'fetching', message: 'Đang tải danh bạ từ Zalo...' });

    const friends = await api.getAllFriends();
    const total = friends.length;
    broadcast({ type: 'scan_progress', phase: 'saving', total, message: `Đã tìm thấy ${total} bạn bè. Đang lưu vào cơ sở dữ liệu...` });

    const insertStmt = db.prepare(`
      INSERT INTO contacts (account_id, uid, name, zalo_name, phone, gender, avatar_url, is_friend, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, uid) DO UPDATE SET
        name = excluded.name,
        zalo_name = excluded.zalo_name,
        phone = COALESCE(excluded.phone, contacts.phone),
        gender = excluded.gender,
        avatar_url = excluded.avatar_url,
        is_friend = 1,
        updated_at = CURRENT_TIMESTAMP
    `);

    const updateMany = db.transaction((list) => {
      let count = 0;
      for (const f of list) {
        insertStmt.run(
          accountId,
          f.userId || f.id,
          f.displayName || f.name || '',
          f.zaloName || '',
          f.phoneNumber || null,
          f.gender === 0 ? 'Nam' : f.gender === 1 ? 'Nữ' : 'Khác',
          f.avatar || null
        );
        count++;
      }
      return count;
    });

    const savedCount = updateMany(friends);
    broadcast({ type: 'scan_complete', total, saved: savedCount, message: `Quét thành công ${savedCount} bạn bè!` });
    return { total, savedCount };
  }

  // Scan friend recommendations using Native AES endpoint: friend-wpa.zaloapp.com/api/friend/recommendsv2/list
  async scanFriendRecommends(accountId, broadcast = () => {}) {
    const api = this.getApi(accountId);
    broadcast({ type: 'scan_progress', phase: 'fetching', message: 'Đang quét danh sách gợi ý kết bạn (recommendsv2) qua Native AES...' });

    const recommends = await getFriendRecommends(api);
    const total = recommends.length;

    if (total === 0) {
      broadcast({ type: 'scan_complete', total: 0, saved: 0, message: 'Không có gợi ý kết bạn mới nào.' });
      return { total: 0, saved: 0, items: [] };
    }

    const insertStmt = db.prepare(`
      INSERT INTO contacts (account_id, uid, name, zalo_name, gender, avatar_url, is_friend, tags, extra_data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'recommend', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, uid) DO UPDATE SET
        name = excluded.name,
        gender = excluded.gender,
        avatar_url = excluded.avatar_url,
        extra_data = excluded.extra_data,
        updated_at = CURRENT_TIMESTAMP
    `);

    let saved = 0;
    db.transaction(() => {
      for (const r of recommends) {
        insertStmt.run(
          accountId,
          r.uid,
          r.name,
          r.name,
          r.gender,
          r.avatar_url,
          JSON.stringify({ status_msg: r.status_msg, recommend_msg: r.recommend_msg, recomm_time: r.recomm_time })
        );
        saved++;
      }
    })();

    broadcast({ type: 'scan_complete', total, saved, message: `Quét thành công ${saved} gợi ý kết bạn mới qua Zalo Protocol!` });
    return { total, saved, items: recommends };
  }

  // Scan all groups
  async scanGroups(accountId, broadcast = () => {}) {
    const api = this.getApi(accountId);
    broadcast({ type: 'scan_progress', phase: 'fetching_groups', message: 'Đang tải danh sách nhóm Zalo...' });

    const res = await api.getAllGroups();
    const groupIds = Object.keys(res.gridVerMap || {});
    const total = groupIds.length;

    if (total === 0) {
      broadcast({ type: 'scan_complete', total: 0, message: 'Tài khoản chưa tham gia nhóm nào.' });
      return { total: 0, savedCount: 0 };
    }

    broadcast({ type: 'scan_progress', phase: 'fetching_details', total, message: `Tìm thấy ${total} nhóm. Đang đọc thông tin chi tiết từng đợt...` });

    const insertStmt = db.prepare(`
      INSERT INTO groups (account_id, group_id, name, avatar_url, member_count, is_joined, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, group_id) DO UPDATE SET
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        member_count = excluded.member_count,
        is_joined = 1,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Chunk groupIds into batches of 25 to respect Zalo API limits (code 114 fix)
    const chunkSize = 25;
    let saved = 0;

    for (let i = 0; i < groupIds.length; i += chunkSize) {
      const chunk = groupIds.slice(i, i + chunkSize);
      try {
        const groupInfoRes = await api.getGroupInfo(chunk);
        const gridInfo = groupInfoRes.gridInfoMap || {};

        db.transaction(() => {
          for (const [gid, info] of Object.entries(gridInfo)) {
            insertStmt.run(
              accountId,
              gid,
              info.name || 'Nhóm không tên',
              info.avatar || null,
              (info.memVerList && info.memVerList.length) || info.totalMember || 0
            );
            saved++;
          }
        })();

        broadcast({
          type: 'scan_progress',
          phase: 'saving_groups',
          current: Math.min(i + chunkSize, total),
          total,
          message: `Đã lưu thông tin ${saved} / ${total} nhóm...`
        });
      } catch (err) {
        console.warn(`Lỗi khi đọc chi tiết nhóm đợt ${i} - ${i + chunkSize}:`, err.message);
      }
    }

    broadcast({ type: 'scan_complete', total, saved, message: `Quét thành công ${saved} nhóm Zalo!` });
    return { total, saved };
  }

  // Scan members of a specific group (Hỗ trợ 100% nhóm ẩn thành viên lockViewMember)
  async scanGroupMembers(accountId, groupId, broadcast = () => {}) {
    const api = this.getApi(accountId);
    broadcast({ type: 'scan_progress', phase: 'fetching_group_info', message: `Đang lấy thông tin nhóm ${groupId}...` });

    // Step 1: lấy UIDs từ memVerList
    const info = await api.getGroupInfo(groupId);
    const group = (info.gridInfoMap && info.gridInfoMap[groupId]) || {};
    const memVerUids = (group.memVerList ?? []).map(s => s.split("_")[0]).filter(Boolean);

    const uidSet = new Set(memVerUids);
    if (group.creatorId) uidSet.add(String(group.creatorId));
    (group.adminIds || []).forEach(a => uidSet.add(String(a)));

    // Quét chuyên sâu mở rộng Bảng tin & Thông báo nhóm (Group Board / Polls) nếu có
    try {
      broadcast({ type: 'scan_progress', phase: 'fetching_board', message: 'Đang quét Bảng tin, thông báo & bài ghim nhóm để bóc tách thành viên ẩn...' });
      let page = 1;
      while (page <= 3) {
        const board = await api.getListBoard({ page, count: 50 }, groupId);
        const items = board?.items || [];
        if (items.length === 0) break;

        for (const it of items) {
          const d = it.data || it;
          if (d.creatorId) uidSet.add(String(d.creatorId));
          if (d.creator) uidSet.add(String(d.creator));
          if (d.editorId) uidSet.add(String(d.editorId));
          if (d.params?.senderUid) uidSet.add(String(d.params.senderUid));
          if (d.params?.creator_id) uidSet.add(String(d.params.creator_id));
          if (Array.isArray(d.members)) d.members.forEach(m => uidSet.add(String(m)));
          if (Array.isArray(d.likers)) d.likers.forEach(l => uidSet.add(String(l)));

          if (d.options && Array.isArray(d.options)) {
            for (const opt of d.options) {
              if (Array.isArray(opt.voters)) {
                opt.voters.forEach(v => {
                  const voterUid = typeof v === 'object' ? (v.uid || v.id) : v;
                  if (voterUid) uidSet.add(String(voterUid));
                });
              }
            }
          }
        }
        page++;
      }
    } catch (boardErr) {
      console.warn(`[scanGroupMembers] Board deep scan notice for group ${groupId}:`, boardErr.message);
    }

    const allUids = Array.from(uidSet);
    const total = allUids.length;

    if (total === 0) {
      broadcast({ type: 'scan_complete', total: 0, message: 'Nhóm không có thành viên nào hoặc không thể đọc danh sách.' });
      return { total: 0, saved: 0 };
    }

    const isLockedView = (group.lockViewMember === 1 || group.setting?.lockViewMember === 1);

    broadcast({
      type: 'scan_progress',
      phase: 'fetching_member_profiles',
      total,
      message: `Tìm thấy ${total} thành viên ${isLockedView ? '(Nhóm BẬT ẩn thành viên)' : ''}. Đang tải chi tiết hồ sơ qua Zalo Protocol...`
    });

    // Xóa dữ liệu cũ của nhóm này để làm mới hoàn toàn
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);

    const insertMemberStmt = db.prepare(`
      INSERT INTO group_members (group_id, uid, name, avatar_url, role, is_friend, is_hidden, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(group_id, uid) DO UPDATE SET
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        role = excluded.role,
        is_friend = excluded.is_friend,
        is_hidden = excluded.is_hidden,
        updated_at = CURRENT_TIMESTAMP
    `);

    let saved = 0;

    // Step 2: fetch tên bằng getUserInfo batch 50 (endpoint /api/social/friend/getprofiles/v2) kết hợp Native AES
    const BATCH = 50;
    for (let i = 0; i < allUids.length; i += BATCH) {
      const batch = allUids.slice(i, i + BATCH);
      let profilesMap = {};

      // Ưu tiên 1: Lấy qua Native PC AES API (profile-wpa.zaloapp.com/api/social/group/members)
      try {
        const nativeProfiles = await fetchNativeGroupMembers(api, batch);
        if (nativeProfiles && Object.keys(nativeProfiles).length > 0) {
          profilesMap = nativeProfiles;
          for (const [uid, p] of Object.entries(nativeProfiles)) {
            console.log(uid, p.displayName || p.zaloName);
          }
        }
      } catch (e) {}

      // Ưu tiên 2: Fallback qua Web API getUserInfo (/api/social/friend/getprofiles/v2) batch 50
      if (Object.keys(profilesMap).length === 0) {
        try {
          const profiles = await api.getUserInfo(batch);
          for (const [key, p] of Object.entries(profiles.changed_profiles ?? {})) {
            const name = p.displayName || p.zaloName;
            const cleanUid = key.replace("_0", "");
            console.log(cleanUid, name);
            profilesMap[cleanUid] = p;
          }
        } catch (userErr) {
          console.warn(`getUserInfo batch ${i} warning:`, userErr.message);
        }
      }

      // Lưu batch vào database
      db.transaction(() => {
        for (const uid of batch) {
          const p = profilesMap[uid] || {};
          const role = (group.creatorId === uid) ? 'creator' : (group.adminIds && group.adminIds.includes(uid)) ? 'admin' : 'member';
          const isFriend = (p.accountStatus === 0 || p.isFriend) ? 1 : 0;
          const isHidden = isLockedView ? (role === 'member' ? 1 : 0) : 0;
          insertMemberStmt.run(
            groupId,
            uid,
            p.displayName || p.zaloName || `Thành viên (${uid})`,
            p.avatar || null,
            role,
            isFriend,
            isHidden
          );
          saved++;
        }
      })();

      broadcast({
        type: 'scan_progress',
        phase: 'saving_members',
        current: Math.min(i + BATCH, total),
        total,
        message: `Đã lưu hồ sơ ${Math.min(i + BATCH, total)} / ${total} thành viên...`
      });

      // Độ trễ an toàn giữa các batch tránh rate-limit
      await new Promise(r => setTimeout(r, 600));
    }

    broadcast({
      type: 'scan_complete',
      total,
      saved,
      message: `🎉 Quét thành công ${saved} thành viên nhóm ${isLockedView ? '(bao gồm toàn bộ thành viên bị ẩn)' : ''}!`
    });

    return { total, saved };
  }

  // Check list of phone numbers with random safety delay
  async checkPhoneNumbers(accountId, phoneList, broadcast = () => {}) {
    const api = this.getApi(accountId);
    const total = phoneList.length;
    broadcast({ type: 'phone_check_start', total, message: `Bắt đầu kiểm tra ${total} số điện thoại...` });

    const insertStmt = db.prepare(`
      INSERT INTO phone_checks (account_id, phone, has_zalo, zalo_name, zalo_id, avatar_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const results = [];
    let checkedCount = 0;
    let foundCount = 0;

    for (const rawPhone of phoneList) {
      const phone = String(rawPhone).trim().replace(/\s+/g, '');
      if (!phone) continue;

      try {
        // Random delay between 1200ms and 2500ms
        const delay = Math.floor(Math.random() * 1300) + 1200;
        await new Promise((resolve) => setTimeout(resolve, delay));

        let user = null;
        let hasZalo = 0;
        let zaloName = null;
        let zaloId = null;
        let avatarUrl = null;

        try {
          user = await api.findUser(phone);
          if (user && (user.uid || user.userId)) {
            hasZalo = 1;
            zaloName = user.display_name || user.displayName || user.zalo_name || user.zaloName;
            zaloId = user.uid || user.userId;
            avatarUrl = user.avatar;
            foundCount++;
          }
        } catch (findErr) {
          hasZalo = 0;
        }

        const status = hasZalo ? 'found' : 'not_found';
        insertStmt.run(accountId, phone, hasZalo, zaloName, zaloId, avatarUrl, status);
        checkedCount++;

        const itemResult = { phone, hasZalo, zaloName, zaloId, avatarUrl, status };
        results.push(itemResult);

        broadcast({
          type: 'phone_check_progress',
          current: checkedCount,
          total,
          item: itemResult,
          message: `[${checkedCount}/${total}] SĐT ${phone}: ${hasZalo ? '✅ Có Zalo (' + zaloName + ')' : '❌ Không có Zalo'}`
        });
      } catch (err) {
        checkedCount++;
        insertStmt.run(accountId, phone, 0, null, null, null, 'error');
        broadcast({
          type: 'phone_check_progress',
          current: checkedCount,
          total,
          item: { phone, hasZalo: 0, status: 'error' },
          message: `[${checkedCount}/${total}] SĐT ${phone}: ⚠️ Lỗi kiểm tra (${err.message})`
        });
      }
    }

    broadcast({
      type: 'phone_check_complete',
      total,
      checked: checkedCount,
      found: foundCount,
      message: `Hoàn tất kiểm tra: Tìm thấy ${foundCount} / ${total} SĐT có Zalo!`
    });

    return { total, checkedCount, foundCount, results };
  }

  // Run Campaign
  async runCampaign(campaignId, broadcast = () => {}) {
    if (this.activeCampaigns.has(campaignId)) {
      throw new Error(`Chiến dịch ID ${campaignId} đang chạy.`);
    }

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new Error('Không tìm thấy chiến dịch.');

    const api = this.getApi(campaign.account_id);
    this.activeCampaigns.add(campaignId);
    db.prepare('UPDATE campaigns SET status = "running" WHERE id = ?').run(campaignId);

    let recipients = [];
    if (campaign.type === 'message_friends') {
      recipients = db.prepare('SELECT * FROM contacts WHERE account_id = ? AND is_friend = 1').all(campaign.account_id);
    } else {
      recipients = db.prepare('SELECT * FROM contacts WHERE account_id = ?').all(campaign.account_id);
    }

    db.prepare('UPDATE campaigns SET total_count = ? WHERE id = ?').run(recipients.length, campaignId);
    broadcast({ type: 'campaign_start', campaignId, total: recipients.length, message: `Bắt đầu gửi tin cho ${recipients.length} người nhận...` });

    const logStmt = db.prepare('INSERT INTO campaign_logs (campaign_id, recipient, status, note) VALUES (?, ?, ?, ?)');
    const updateStatsStmt = db.prepare('UPDATE campaigns SET sent_count = sent_count + ?, failed_count = failed_count + ? WHERE id = ?');

    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      if (!this.activeCampaigns.has(campaignId)) {
        broadcast({ type: 'campaign_stopped', campaignId, message: 'Chiến dịch đã được tạm dừng.' });
        db.prepare('UPDATE campaigns SET status = "paused" WHERE id = ?').run(campaignId);
        break;
      }

      const messageText = renderMessage(campaign.template, recipient);
      const recipientId = recipient.uid;

      try {
        const minMs = (campaign.delay_min || 5) * 1000;
        const maxMs = (campaign.delay_max || 15) * 1000;
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        await new Promise((resolve) => setTimeout(resolve, delay));

        await api.sendMessage(messageText, recipientId);
        sent++;
        logStmt.run(campaignId, recipient.name || recipientId, 'success', `Gửi thành công: ${messageText.slice(0, 30)}...`);
        updateStatsStmt.run(1, 0, campaignId);

        broadcast({
          type: 'campaign_progress',
          campaignId,
          sent,
          failed,
          total: recipients.length,
          message: `Gửi thành công tới: ${recipient.name || recipientId}`
        });
      } catch (err) {
        failed++;
        logStmt.run(campaignId, recipient.name || recipientId, 'error', err.message);
        updateStatsStmt.run(0, 1, campaignId);

        broadcast({
          type: 'campaign_progress',
          campaignId,
          sent,
          failed,
          total: recipients.length,
          message: `Lỗi gửi tới ${recipient.name || recipientId}: ${err.message}`
        });
      }
    }

    this.activeCampaigns.delete(campaignId);
    db.prepare('UPDATE campaigns SET status = "completed" WHERE id = ?').run(campaignId);
    broadcast({ type: 'campaign_complete', campaignId, sent, failed, total: recipients.length, message: `Chiến dịch hoàn tất! Đã gửi: ${sent}, Thất bại: ${failed}` });
  }

  stopCampaign(campaignId) {
    if (this.activeCampaigns.has(campaignId)) {
      this.activeCampaigns.delete(campaignId);
      db.prepare('UPDATE campaigns SET status = "paused" WHERE id = ?').run(campaignId);
      return true;
    }
    return false;
  }

  // ================= EXPANDED ZCA-JS NATIVE PROTOCOL APIS =================

  // 1. Friend Management APIs (Ultra-fast Protocol)
  async sendFriendRequestByPhone(accountId, phone, greeting = '{Chào bạn|Xin chào}, mình muốn kết bạn cùng bạn!') {
    const api = this.getApi(accountId);
    const userProfile = await api.findUser(phone);
    if (!userProfile || !userProfile.uid) {
      throw new Error(`Không tìm thấy người dùng Zalo với số điện thoại: ${phone}`);
    }

    const finalGreeting = renderMessage(greeting, { phone, name: userProfile.displayName || userProfile.zalo_name || phone });
    const res = await api.sendFriendRequest(finalGreeting, userProfile.uid);
    return { ok: true, phone, user: userProfile, result: res };
  }

  async acceptFriendRequest(accountId, userId) {
    const api = this.getApi(accountId);
    const res = await api.acceptFriendRequest(userId);
    return { ok: true, userId, result: res };
  }

  async undoFriendRequest(accountId, userId) {
    const api = this.getApi(accountId);
    const res = await api.undoFriendRequest(userId);
    return { ok: true, userId, result: res };
  }

  async removeFriend(accountId, userId) {
    const api = this.getApi(accountId);
    const res = await api.removeFriend(userId);
    return { ok: true, userId, result: res };
  }

  async getFriendRecommendations(accountId) {
    const api = this.getApi(accountId);
    const res = await api.getFriendRecommendations();
    return res;
  }

  async getSentFriendRequests(accountId) {
    const api = this.getApi(accountId);
    const res = await api.getSentFriendRequest();
    return res;
  }

  // 2. Group Management APIs (Ultra-fast Protocol)
  async createGroup(accountId, groupName, memberUids = []) {
    const api = this.getApi(accountId);
    const res = await api.createGroup({
      name: groupName,
      members: memberUids
    });
    return { ok: true, group: res };
  }

  async addUsersToGroup(accountId, groupId, memberUids) {
    const api = this.getApi(accountId);
    const members = Array.isArray(memberUids) ? memberUids : [memberUids];
    const res = await api.addUserToGroup(members, groupId);
    return { ok: true, groupId, addedCount: members.length, result: res };
  }

  async removeUserFromGroup(accountId, groupId, memberUid) {
    const api = this.getApi(accountId);
    const res = await api.removeUserFromGroup(memberUid, groupId);
    return { ok: true, groupId, removedUid: memberUid, result: res };
  }

  async changeGroupName(accountId, groupId, newName) {
    const api = this.getApi(accountId);
    const res = await api.changeGroupName(groupId, newName);
    return { ok: true, groupId, newName, result: res };
  }

  async joinGroupByLink(accountId, link) {
    const api = this.getApi(accountId);
    const res = await api.joinGroupLink(link);
    return { ok: true, link, result: res };
  }

  async leaveGroup(accountId, groupId) {
    const api = this.getApi(accountId);
    const res = await api.leaveGroup(groupId);
    return { ok: true, groupId, result: res };
  }

  async createGroupPoll(accountId, groupId, question, options) {
    const api = this.getApi(accountId);
    const opts = Array.isArray(options) ? options : options.split('\n').map(o => o.trim()).filter(Boolean);
    const res = await api.createPoll({
      groupId,
      question,
      options: opts
    });
    return { ok: true, groupId, question, result: res };
  }

  async createGroupNote(accountId, groupId, content) {
    const api = this.getApi(accountId);
    const res = await api.createNote({
      groupId,
      content,
      pin: true
    });
    return { ok: true, groupId, result: res };
  }

  // 3. Media & Advanced Messaging APIs
  async sendAttachment(accountId, threadId, filePath, isGroup = false) {
    const api = this.getApi(accountId);
    const res = await api.uploadAttachment(filePath, threadId, isGroup ? 1 : 0);
    return { ok: true, threadId, filePath, result: res };
  }

  async sendLinkPreview(accountId, threadId, url) {
    const api = this.getApi(accountId);
    const res = await api.sendLink(threadId, url);
    return { ok: true, threadId, url, result: res };
  }

  async undoMessage(accountId, messageId) {
    const api = this.getApi(accountId);
    const res = await api.undo(messageId);
    return { ok: true, messageId, result: res };
  }

  // 4. Realtime AI Auto Chatbot / CSKH 24/7 (via zca-js listener)
  startChatbot(accountId, config = {}, broadcast = () => {}) {
    const api = this.getApi(accountId);
    if (this.activeListeners?.has(accountId)) {
      return { ok: true, message: 'Chatbot đang hoạt động sẵn.' };
    }

    if (!this.activeListeners) this.activeListeners = new Map();
    if (!this.chatbotConfigs) this.chatbotConfigs = new Map();

    this.chatbotConfigs.set(accountId, {
      enabled: true,
      tone: config.tone || 'friendly',
      replyDelaySec: config.replyDelaySec || 2,
      customSpintax: config.customSpintax || '{Chào bạn!|Dạ shop chào bạn ạ!} {Shop đã nhận được tin nhắn của bạn và sẽ phản hồi trong giây lát nhé!|Cảm ơn bạn đã nhắn tin cho shop. Shop hỗ trợ bạn ngay đây ạ! ❤️}'
    });

    const listener = api.listener;
    if (!listener) {
      throw new Error('API instance không hỗ trợ WebSocket listener.');
    }

    listener.on('connected', () => {
      broadcast({ type: 'task_log', message: `🤖 Zalo AI Chatbot đã kích hoạt kết nối WebSocket realtime cho tài khoản #${accountId}!` });
    });

    listener.on('message', async (message) => {
      const cfg = this.chatbotConfigs.get(accountId);
      if (!cfg || !cfg.enabled) return;

      // Don't reply to self messages
      if (message.isSelf) return;

      const senderId = message.senderId || message.uidFrom || message.threadId;
      const content = typeof message.data?.content === 'string' ? message.data.content : (message.content || '');

      broadcast({
        type: 'task_log',
        message: `📩 [Tin nhắn mới từ ${message.senderName || senderId}]: "${content}"`
      });

      // Analyze message with AI Service
      const aiService = require('./services/aiService');
      let replyText = '';

      if (content) {
        const replyResult = aiService.writeReplyCmt(content);
        replyText = replyResult.reply;
      } else {
        replyText = cfg.customSpintax;
      }

      const finalReply = renderMessage(replyText, { name: message.senderName || 'bạn' });

      // Artificial human delay before replying
      setTimeout(async () => {
        try {
          await api.sendMessage(finalReply, message.threadId);
          broadcast({
            type: 'task_log',
            message: `🤖 [Auto-reply đã gửi tới ${message.senderName || senderId}]: "${finalReply}"`
          });
        } catch (err) {
          console.error('Chatbot reply error:', err.message);
        }
      }, (cfg.replyDelaySec || 2) * 1000);
    });

    listener.start({ retryOnClose: true });
    this.activeListeners.set(accountId, listener);

    return { ok: true, message: 'Đã kích hoạt Zalo AI Chatbot CSKH 24/7 thành công!' };
  }

  // Gửi tin nhắn qua Zalo Protocol (Hỗ trợ Direct Message và Share/Forward Method ngầm)
  async sendMessageProtocol(accountId, targetUid, messageText, broadcast = () => {}) {
    const api = this.getApi(accountId);
    const { ThreadType } = require('zca-js');
    const finalMsg = renderMessage(messageText, { target: targetUid, uid: targetUid });

    try {
      const res = await api.sendMessage(finalMsg, String(targetUid), ThreadType.User);
      broadcast({ type: 'task_log', message: `✅ Gửi thành công tới ${targetUid} qua Zalo Protocol` });
      return { ok: true, data: res };
    } catch (err) {
      // Nếu gửi trực tiếp gặp hạn chế, chuyển tiếp tin nhắn qua Forward Message (Share Method ngầm)
      try {
        const forwardRes = await api.forwardMessage({ message: finalMsg }, [String(targetUid)], ThreadType.User);
        broadcast({ type: 'task_log', message: `✅ Gửi thành công tới ${targetUid} qua Share Method Protocol` });
        return { ok: true, data: forwardRes };
      } catch (fErr) {
        throw new Error(`Lỗi gửi tin: ${err.message || fErr.message}`);
      }
    }
  }

  stopChatbot(accountId, broadcast = () => {}) {
    if (this.activeListeners?.has(accountId)) {
      const listener = this.activeListeners.get(accountId);
      try {
        if (listener.stop) listener.stop();
        else if (listener.ws) listener.ws.close();
      } catch (e) {}
      this.activeListeners.delete(accountId);
      this.chatbotConfigs?.delete(accountId);
      broadcast({ type: 'task_log', message: `⏹️ Đã dừng Zalo AI Chatbot cho tài khoản #${accountId}.` });
      return { ok: true, message: 'Đã dừng Chatbot.' };
    }
    return { ok: false, message: 'Chatbot chưa được kích hoạt.' };
  }
}

module.exports = new ZaloManager();
