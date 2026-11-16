const crypto = require('crypto');

/**
 * Xây dựng chuỗi Cookie header chuẩn cho từng subdomain của Zalo
 */
function buildCookie(cookieInput, url) {
  if (!cookieInput) return '';
  let list = [];
  if (Array.isArray(cookieInput)) {
    list = cookieInput;
  } else if (cookieInput.cookies && Array.isArray(cookieInput.cookies)) {
    list = cookieInput.cookies;
  } else if (typeof cookieInput === 'object') {
    list = Object.values(cookieInput);
  } else if (typeof cookieInput === 'string') {
    try {
      const parsed = JSON.parse(cookieInput);
      list = Array.isArray(parsed) ? parsed : (parsed.cookies || Object.values(parsed));
    } catch (e) {
      return cookieInput;
    }
  }

  const { hostname } = new URL(url);
  return list
    .filter((c) => {
      const d = c.domain || '';
      return hostname.endsWith(d) || d.includes('zaloapp.com') || d.includes('zalo.me');
    })
    .map((c) => `${c.name || c.key}=${c.value}`)
    .join('; ');
}

/**
 * Mã hóa dữ liệu bằng thuật toán AES-CBC với key zpw_enk
 */
function aesEncrypt(plaintext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
  const iv = Buffer.alloc(16, 0);
  const algo = keyBuf.length === 16 ? 'aes-128-cbc' : keyBuf.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
  const cipher = crypto.createCipheriv(algo, keyBuf, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * Giải mã dữ liệu phản hồi từ Zalo bằng thuật toán AES-CBC với key zpw_enk
 */
function aesDecrypt(ciphertext, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
  const iv = Buffer.alloc(16, 0);
  const algo = keyBuf.length === 16 ? 'aes-128-cbc' : keyBuf.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
  const decipher = crypto.createDecipheriv(algo, keyBuf, iv);
  const ct = Buffer.from(decodeURIComponent(ciphertext), 'base64');
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function getCookieHeaderFromCtx(ctx, url) {
  if (ctx && ctx.cookie && typeof ctx.cookie.getCookieStringSync === 'function') {
    const s1 = ctx.cookie.getCookieStringSync('https://chat.zalo.me') || '';
    const s2 = ctx.cookie.getCookieStringSync('https://zalo.me') || '';
    const s3 = ctx.cookie.getCookieStringSync(url) || '';
    const cookieMap = new Map();
    for (const s of [s1, s2, s3]) {
      s.split(';').map(x => x.trim()).filter(Boolean).forEach(part => {
        const idx = part.indexOf('=');
        if (idx !== -1) cookieMap.set(part.slice(0, idx), part.slice(idx + 1));
      });
    }
    return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return buildCookie(ctx?.cookie || [], url);
}

/**
 * API Native PC: profile-wpa.zaloapp.com/api/social/group/members (Bucket rate-limit riêng biệt, hiếm khi 221)
 * Nhận mảng UID, trả về hồ sơ profiles chi tiết
 */
async function getProfiles(api, uids) {
  try {
    const ctx = api.getContext();
    const zpw_enk = ctx.secretKey;
    if (!zpw_enk) return null;

    const url = 'https://profile-wpa.zaloapp.com/api/social/group/members';
    const friendPversionMap = uids.map((u) => (u.endsWith('_0') ? u : `${u}_0`));
    const encBody = aesEncrypt(JSON.stringify({ friend_pversion_map: friendPversionMap }), zpw_enk);

    const queryParams = new URLSearchParams({
      zpw_type: '30',
      zpw_ver: '671',
      imei: ctx.imei || ''
    });

    const cookieHeader = getCookieHeaderFromCtx(ctx, url);

    const resp = await fetch(`${url}?${queryParams.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ctx.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1',
        'Cookie': cookieHeader
      },
      body: `params=${encodeURIComponent(encBody)}`
    });

    if (!resp.ok) return null;
    const resJson = await resp.json();
    if (!resJson?.data) return null;

    const decrypted = JSON.parse(aesDecrypt(resJson.data, zpw_enk));
    if (decrypted && decrypted.error_code === 0 && (decrypted.data?.profiles || decrypted.profiles)) {
      return decrypted.data?.profiles || decrypted.profiles;
    }
    return null;
  } catch (err) {
    console.warn('[getProfiles] Error:', err.message);
    return null;
  }
}

/**
 * API Native PC: friend-wpa.zaloapp.com/api/friend/recommendsv2/list
 * Quét danh sách gợi ý kết bạn kèm hồ sơ chi tiết bằng cơ chế mã hóa AES
 */
async function getFriendRecommends(api) {
  try {
    const ctx = api.getContext();
    const zpw_enk = ctx.secretKey;
    if (!zpw_enk) return [];

    const url = 'https://friend-wpa.zaloapp.com/api/friend/recommendsv2/list';
    const encBody = aesEncrypt(JSON.stringify({}), zpw_enk);

    const queryParams = new URLSearchParams({
      zpw_type: '30',
      zpw_ver: '671',
      imei: ctx.imei || ''
    });

    const cookieHeader = getCookieHeaderFromCtx(ctx, url);

    const resp = await fetch(`${url}?${queryParams.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ctx.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1',
        'Cookie': cookieHeader
      },
      body: `params=${encodeURIComponent(encBody)}`
    });

    if (!resp.ok) return [];
    const resJson = await resp.json();
    if (!resJson?.data) return [];

    const decrypted = JSON.parse(aesDecrypt(resJson.data, zpw_enk));
    const items = decrypted?.data?.recommItems || [];

    return items.map((it) => {
      const d = it.dataInfo || it;
      return {
        uid: d.userId,
        name: d.displayName || d.zaloName || 'Gợi ý kết bạn',
        avatar_url: d.avatar || null,
        gender: d.gender === 0 ? 'Nam' : d.gender === 1 ? 'Nữ' : 'Khác',
        status_msg: d.status || '',
        recommend_msg: d.recommInfo?.message || '',
        recomm_time: d.recommTime || null
      };
    });
  } catch (err) {
    console.warn('[getFriendRecommends] Error:', err.message);
    return [];
  }
}

/**
 * API Web /api/social/friend/getprofiles/v2:
 * Step 1: Lấy UIDs từ memVerList của getGroupInfo
 * Step 2: Fetch thông tin tên (displayName/zaloName) bằng getUserInfo batch 50
 */
async function getGroupMembersViaUserInfo(api, groupId) {
  // Step 1: lấy UIDs từ memVerList
  const info = await api.getGroupInfo(groupId);
  const group = (info.gridInfoMap && info.gridInfoMap[groupId]) || {};
  const allUids = (group.memVerList ?? []).map(s => s.split("_")[0]);

  const memberProfiles = {};

  // Step 2: fetch tên bằng getUserInfo batch 50
  const BATCH = 50;
  for (let i = 0; i < allUids.length; i += BATCH) {
    const batch = allUids.slice(i, i + BATCH);
    const profiles = await api.getUserInfo(batch);
    for (const [key, p] of Object.entries(profiles.changed_profiles ?? {})) {
      const name = p.displayName || p.zaloName;
      const cleanUid = key.replace("_0", "");
      console.log(cleanUid, name);
      memberProfiles[cleanUid] = {
        name,
        avatar: p.avatar,
        accountStatus: p.accountStatus,
        isFriend: p.isFriend
      };
    }
  }

  return {
    group,
    allUids,
    profiles: memberProfiles
  };
}

module.exports = {
  buildCookie,
  aesEncrypt,
  aesDecrypt,
  getProfiles,
  getFriendRecommends,
  getGroupMembersViaUserInfo
};
