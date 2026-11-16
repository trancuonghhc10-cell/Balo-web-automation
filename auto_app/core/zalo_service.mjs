import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Zalo,
    ThreadType,
    LoginQRCallbackEventType
} from '../../zca-js/dist/index.js';
import { API } from '../../zca-js/dist/apis.js';
import { createContext } from '../../zca-js/dist/context.js';
import { fetchProfileWpa } from './profile_wpa_helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
const SESSIONS_DIR = path.resolve(DATA_DIR, 'zalo_sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory active sessions, QR login states, and message listeners
const activeSessions = new Map();   // accountId -> API instance
const qrLoginStates = new Map();    // accountId -> { status, qr_image, token, user, error, actions }
const activeListeners = new Map();  // accountId -> listener instance
const listenerRules = new Map();    // accountId -> rules array

function getSessionFilePath(accountId) {
    return path.join(SESSIONS_DIR, `acc_${accountId}.json`);
}

function saveSessionData(accountId, credentials) {
    const filePath = getSessionFilePath(accountId);
    fs.writeFileSync(filePath, JSON.stringify({
        ...credentials,
        savedAt: new Date().toISOString()
    }, null, 2), 'utf8');
}

function loadSessionData(accountId) {
    const filePath = getSessionFilePath(accountId);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function prepareCookiesForZalo(cookieList) {
    if (!cookieList) return [];
    const list = Array.isArray(cookieList) ? [...cookieList] : (cookieList.cookies ? [...cookieList.cookies] : []);
    const sek = list.find(c => (c.key || c.name) === 'zpw_sek');
    const psid = list.find(c => (c.key || c.name) === 'zpsid');

    const domains = ['zalo.me', 'chat.zalo.me', 'zaloapp.com', 'group-wpa.zaloapp.com', 'profile-wpa.zaloapp.com'];

    if (sek) {
        for (const dom of domains) {
            if (!list.some(c => (c.key || c.name) === 'zpw_sek' && c.domain === dom)) {
                list.push({
                    ...sek,
                    key: 'zpw_sek',
                    name: 'zpw_sek',
                    domain: dom,
                    hostOnly: false
                });
            }
        }
    }
    if (psid) {
        for (const dom of domains) {
            if (!list.some(c => (c.key || c.name) === 'zpsid' && c.domain === dom)) {
                list.push({
                    ...psid,
                    key: 'zpsid',
                    name: 'zpsid',
                    domain: dom,
                    hostOnly: false
                });
            }
        }
    }
    return list;
}

function syncApiCookieJar(api) {
    if (api && api.listener && api.listener.ctx && api.listener.ctx.cookie) {
        const jar = api.listener.ctx.cookie;
        try {
            const cookies = jar.toJSON ? jar.toJSON().cookies : [];
            const sek = cookies.find(c => (c.key || c.name) === 'zpw_sek');
            const psid = cookies.find(c => (c.key || c.name) === 'zpsid');
            if (sek && sek.value) {
                jar.setCookieSync(`zpw_sek=${sek.value}; Domain=zaloapp.com; Path=/; Secure`, 'https://group-wpa.zaloapp.com');
                jar.setCookieSync(`zpw_sek=${sek.value}; Domain=zaloapp.com; Path=/; Secure`, 'https://profile-wpa.zaloapp.com');
            }
            if (psid && psid.value) {
                jar.setCookieSync(`zpsid=${psid.value}; Domain=zaloapp.com; Path=/; Secure`, 'https://group-wpa.zaloapp.com');
                jar.setCookieSync(`zpsid=${psid.value}; Domain=zaloapp.com; Path=/; Secure`, 'https://profile-wpa.zaloapp.com');
            }
        } catch (e) {
            console.warn('[ZaloService] Cookie jar sync warning:', e.message);
        }
    }
}

async function getOrRestoreSession(accountId) {
    if (activeSessions.has(accountId)) {
        return activeSessions.get(accountId);
    }
    const creds = loadSessionData(accountId);
    if (!creds || !creds.cookie || !creds.imei) {
        return null;
    }

    // Path 1: Fast direct restore if full session data (secretKey, zpwServiceMap) is saved
    if (creds.secretKey && creds.zpwServiceMap) {
        try {
            const zalo = new Zalo({ logging: false });
            const ctx = createContext(30, 685);
            ctx.imei = creds.imei;
            ctx.userAgent = creds.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
            ctx.language = creds.language || 'vi';
            ctx.secretKey = creds.secretKey;
            ctx.uid = creds.uid || creds.own_id;
            ctx.cookie = zalo.parseCookies(prepareCookiesForZalo(creds.cookie));
            ctx.settings = creds.settings || {};
            ctx.extraVer = creds.extraVer || {};
            ctx.loginInfo = creds.loginInfo || {};

            const api = new API(ctx, creds.zpwServiceMap, creds.wsUrls || creds.loginInfo?.zpw_ws || []);
            syncApiCookieJar(api);
            activeSessions.set(accountId, api);
            console.log(`[ZaloService] Fast-restored active session for account ${accountId} (UID: ${creds.uid || api.getOwnId()})`);
            return api;
        } catch (fastErr) {
            console.warn(`[ZaloService] Fast-restore failed for account ${accountId}: ${fastErr.message}, falling back to standard login...`);
        }
    }

    // Path 2: Standard zalo.login
    try {
        const zalo = new Zalo({ logging: false });
        const preparedCookies = prepareCookiesForZalo(creds.cookie);
        const api = await zalo.login({
            imei: creds.imei,
            cookie: preparedCookies,
            userAgent: creds.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            language: creds.language || 'vi'
        });
        syncApiCookieJar(api);
        activeSessions.set(accountId, api);
        console.log(`[ZaloService] Restored active session for account ${accountId} (UID: ${api.getOwnId()})`);
        return api;
    } catch (err) {
        console.error(`[ZaloService] Failed to restore session for account ${accountId}:`, err.message);
        return null;
    }
}

async function autoRestoreAllSavedSessions() {
    try {
        const files = fs.readdirSync(SESSIONS_DIR);
        for (const f of files) {
            const m = f.match(/^acc_(\d+)\.json$/);
            if (m) {
                const accId = Number(m[1]);
                console.log(`[ZaloService] Auto-restoring session for account ${accId}...`);
                await getOrRestoreSession(accId);
            }
        }
    } catch (e) {}
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON: ' + e.message));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

// HTTP Server
const PORT = 8001;
const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
        // --- 1. Health check ---
        if (pathname === '/api/health') {
            return sendJson(res, 200, {
                status: 'ok',
                active_sessions: Array.from(activeSessions.keys()),
                active_listeners: Array.from(activeListeners.keys()),
                timestamp: Date.now()
            });
        }

        // --- 2. QR Login: Start ---
        if (pathname === '/api/login-qr/start' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const accountId = Number(body.account_id);
            if (!accountId) return sendJson(res, 400, { error: 'account_id required' });

            const existing = qrLoginStates.get(accountId);
            if (existing && existing.actions && existing.actions.abort) {
                try { existing.actions.abort(); } catch(e) {}
            }

            const state = {
                status: 'initializing',
                qr_image: null,
                token: null,
                user: null,
                error: null,
                actions: null
            };
            qrLoginStates.set(accountId, state);

            const zalo = new Zalo({ logging: true });
            const ua = body.user_agent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

            (async () => {
                try {
                    const api = await zalo.loginQR({ userAgent: ua, language: 'vi' }, (event) => {
                        if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
                            state.status = 'waiting_scan';
                            state.qr_image = `data:image/png;base64,${event.data.image}`;
                            state.token = event.data.token;
                            state.actions = event.actions;
                        } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
                            state.status = 'scanned';
                            state.user = {
                                display_name: event.data.display_name,
                                avatar: event.data.avatar
                            };
                            state.actions = event.actions;
                        } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
                            state.status = 'declined';
                            state.error = 'Người dùng đã từ chối xác nhận đăng nhập trên điện thoại';
                        } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
                            state.status = 'expired';
                            state.error = 'Mã QR đã hết hạn, vui lòng tạo lại';
                        } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
                            saveSessionData(accountId, {
                                imei: event.data.imei,
                                cookie: event.data.cookie,
                                userAgent: event.data.userAgent,
                                language: 'vi'
                            });
                        }
                    });

                    activeSessions.set(accountId, api);
                    syncApiCookieJar(api);
                    state.status = 'success';
                    state.actions = null;
                    if (api.listener && api.listener.ctx) {
                        try {
                            const ctx = api.listener.ctx;
                            const fullCookies = ctx.cookie?.toJSON ? ctx.cookie.toJSON().cookies : [];
                            saveSessionData(accountId, {
                                imei: ctx.imei,
                                cookie: prepareCookiesForZalo(fullCookies),
                                userAgent: ctx.userAgent || ua,
                                language: 'vi',
                                secretKey: ctx.secretKey,
                                uid: ctx.uid || api.getOwnId(),
                                own_id: api.getOwnId(),
                                loginInfo: ctx.loginInfo,
                                settings: ctx.settings,
                                extraVer: ctx.extraVer,
                                zpwServiceMap: api.zpwServiceMap,
                                wsUrls: api.listener.wsUrls || ctx.loginInfo?.zpw_ws || [],
                                savedAt: new Date().toISOString()
                            });
                            console.log(`[ZaloService] Saved complete persistent session for account ${accountId} (UID: ${api.getOwnId()})`);
                        } catch (sErr) {
                            console.warn(`[ZaloService] Warning saving session: ${sErr.message}`);
                        }
                    }
                    console.log(`[ZaloService] Account ${accountId} logged in successfully via QR! UID: ${api.getOwnId()}`);
                } catch (err) {
                    console.error(`[ZaloService] QR login error for account ${accountId}:`, err);
                    state.status = 'error';
                    state.error = err.message || 'Lỗi đăng nhập QR';
                }
            })();

            return sendJson(res, 200, { success: true, message: 'QR login started' });
        }

        // --- 3. QR Login: Poll Status ---
        if (pathname === '/api/login-qr/status' && req.method === 'GET') {
            const accountId = Number(parsedUrl.searchParams.get('account_id'));
            if (!accountId) return sendJson(res, 400, { error: 'account_id required' });

            const state = qrLoginStates.get(accountId);
            if (!state) {
                return sendJson(res, 404, { error: 'No active QR login found for this account' });
            }
            return sendJson(res, 200, {
                status: state.status,
                qr_image: state.qr_image,
                user: state.user,
                error: state.error
            });
        }

        // --- 4. QR Login: Abort ---
        if (pathname === '/api/login-qr/abort' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const accountId = Number(body.account_id);
            const state = qrLoginStates.get(accountId);
            if (state && state.actions && state.actions.abort) {
                try { state.actions.abort(); } catch(e) {}
            }
            qrLoginStates.delete(accountId);
            return sendJson(res, 200, { success: true });
        }

        // --- 5. Session Status / Load ---
        if (pathname === '/api/session/status' && req.method === 'GET') {
            const accountId = Number(parsedUrl.searchParams.get('account_id'));
            let hasActive = activeSessions.has(accountId);
            const hasSaved = fs.existsSync(getSessionFilePath(accountId));
            
            // Auto-restore if saved exists but not in active map
            if (!hasActive && hasSaved) {
                try {
                    await getOrRestoreSession(accountId);
                    hasActive = activeSessions.has(accountId);
                } catch (e) {}
            }

            let ownId = null;
            if (hasActive) {
                try { ownId = activeSessions.get(accountId).getOwnId(); } catch(e) {}
            }
            return sendJson(res, 200, {
                active: hasActive,
                has_saved_session: hasSaved,
                own_id: ownId
            });
        }

        if (pathname === '/api/session/load' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const accountId = Number(body.account_id);
            const api = await getOrRestoreSession(accountId);
            if (!api) {
                return sendJson(res, 400, { success: false, error: 'Chưa có phiên lưu hoặc phiên hết hạn' });
            }
            return sendJson(res, 200, { success: true, own_id: api.getOwnId() });
        }

        // --- 6. Import / Save session directly ---
        if ((pathname === '/api/session/import' || pathname === '/api/session/save') && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const accountId = Number(body.account_id);
            if (!accountId || !body.cookie || !body.imei) {
                return sendJson(res, 400, { error: 'account_id, cookie, imei required' });
            }
            saveSessionData(accountId, {
                imei: body.imei,
                cookie: body.cookie,
                userAgent: body.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                language: 'vi'
            });
            const api = await getOrRestoreSession(accountId);
            if (!api) {
                return sendJson(res, 400, { success: false, error: 'Khởi tạo session từ cookie thất bại' });
            }
            return sendJson(res, 200, { success: true, own_id: api.getOwnId() });
        }

        // --- Require valid session for following routes ---
        const accMatch = pathname.match(/^\/api\/account\/(\d+)\/(.+)$/);
        if (accMatch) {
            const accountId = Number(accMatch[1]);
            const action = accMatch[2];

            const api = await getOrRestoreSession(accountId);
            if (!api) {
                return sendJson(res, 401, {
                    success: false,
                    error: `Tài khoản #${accountId} chưa đăng nhập Zalo hoặc phiên đã hết hạn. Vui lòng quét mã QR để kết nối!`
                });
            }

            if (action === 'debug-session' && req.method === 'GET') {
                return sendJson(res, 200, {
                    has_listener: !!api.listener,
                    secretKey: api.listener?.ctx?.secretKey,
                    imei: api.listener?.ctx?.imei,
                    cookies: api.listener?.ctx?.cookie?.toJSON()?.cookies,
                    zpwServiceMap: api.zpwServiceMap
                });
            }

            // 6.1 Get all groups
            if (action === 'groups' && req.method === 'GET') {
                try {
                    const groupListRes = await api.getAllGroups();
                    const groupIds = Object.keys(groupListRes.gridVerMap || {});
                    if (!groupIds.length) {
                        return sendJson(res, 200, { success: true, count: 0, items: [] });
                    }

                    const groupInfoRes = await api.getGroupInfo(groupIds);
                    const gridInfoMap = groupInfoRes.gridInfoMap || {};

                    const items = Object.entries(gridInfoMap).map(([id, g]) => {
                        const isHidden = g.setting ? (g.setting.lockViewMember === 1) : false;
                        return {
                            id: id,
                            uid: id,
                            name: g.name || id,
                            desc: g.desc || '',
                            total_members: g.totalMember || 0,
                            avatar: g.avatar || '',
                            is_hidden_members: isHidden,
                            creator_id: g.creatorId || '',
                            admin_ids: g.adminIds || [],
                            type: 'group'
                        };
                    });

                    return sendJson(res, 200, { success: true, count: items.length, items });
                } catch (groupErr) {
                    console.error('[ZaloService] Error fetching groups:', groupErr.message);
                    return sendJson(res, 500, { success: false, error: `Lỗi lấy danh sách nhóm: ${groupErr.message}` });
                }
            }

            // 6.2 Get Group Members (only for groups where member list is accessible)
            if (action === 'group-members' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const groupId = body.groupId || body.group_id;
                if (!groupId) return sendJson(res, 400, { error: 'groupId required' });

                try {
                    console.log(`[ZaloService] Fetching members for group ${groupId}...`);
                    const groupInfoRes = await api.getGroupInfo(groupId);
                    const groupInfo = (groupInfoRes.gridInfoMap && groupInfoRes.gridInfoMap[groupId]) || {};
                    
                    const adminIds = groupInfo.adminIds || [];
                    const creatorId = groupInfo.creatorId || '';
                    const ownId = api.getOwnId ? api.getOwnId() : '';
                    const isAdmin = (ownId && (creatorId === ownId || adminIds.includes(ownId)));
                    const isHidden = groupInfo.setting ? (groupInfo.setting.lockViewMember === 1) : false;

                    // Use memberIds for non-hidden groups, or when user is admin
                    const rawMemberIds = groupInfo.memberIds || [];
                    
                    if (isHidden && !isAdmin && rawMemberIds.length === 0) {
                        return sendJson(res, 200, {
                            success: true,
                            group_id: groupId,
                            group_name: groupInfo.name || groupId,
                            is_hidden_members: true,
                            total_members: groupInfo.totalMember || 0,
                            items: [],
                            message: `Nhóm "${groupInfo.name || groupId}" đã bật ẩn danh sách thành viên. Bạn cần quyền quản trị viên để xem.`
                        });
                    }

                    const memberUids = rawMemberIds.map(s => String(s).split('_')[0]).filter(Boolean);
                    console.log(`[ZaloService] Group ${groupId}: processing ${memberUids.length} member UIDs (hidden=${isHidden}, isAdmin=${isAdmin}). Fetching profiles...`);

                    const profiles = {};
                    const chunkSize = 50;
                    for (let i = 0; i < memberUids.length; i += chunkSize) {
                        const chunk = memberUids.slice(i, i + chunkSize);
                        
                        // getUserInfo (batch 50 via /api/social/friend/getprofiles/v2)
                        try {
                            if (typeof api.getUserInfo === 'function') {
                                const userRes = await api.getUserInfo(chunk);
                                if (userRes && userRes.changed_profiles) {
                                    for (const [k, p] of Object.entries(userRes.changed_profiles)) {
                                        const u = k.replace(/_0$/, '');
                                        profiles[u] = p;
                                    }
                                }
                            }
                        } catch (e1) {
                            console.warn(`[ZaloService] getUserInfo chunk [${i}] warning:`, e1.message);
                        }

                        // Fallback for any members not yet resolved
                        const missing = chunk.filter(u => !profiles[u]);
                        if (missing.length > 0) {
                            try {
                                const profRes = await api.getGroupMembersInfo(missing);
                                if (profRes && profRes.profiles) {
                                    Object.assign(profiles, profRes.profiles);
                                } else {
                                    const fallback = await fetchProfileWpa(missing, api);
                                    if (fallback && fallback.profiles) {
                                        Object.assign(profiles, fallback.profiles);
                                    }
                                }
                            } catch (e2) {
                                console.warn(`[ZaloService] profile fallback chunk [${i}] warning:`, e2.message);
                            }
                        }
                    }

                    const items = memberUids.map(uid => {
                        const p = profiles[uid] || {};
                        let role = 'Thành viên';
                        if (uid === creatorId) role = 'Trưởng nhóm';
                        else if (adminIds.includes(uid)) role = 'Phó nhóm';

                        return {
                            id: uid,
                            uid: uid,
                            name: p.displayName || p.zaloName || `Người dùng ${uid}`,
                            zalo_name: p.zaloName || '',
                            avatar: p.avatar || '',
                            role: role,
                            global_id: p.globalId || '',
                            is_admin: uid === creatorId || adminIds.includes(uid),
                            type: 'member'
                        };
                    });

                    return sendJson(res, 200, {
                        success: true,
                        group_id: groupId,
                        group_name: groupInfo.name || groupId,
                        is_hidden_members: isHidden,
                        total_members: memberUids.length,
                        items: items
                    });
                } catch (memberErr) {
                    console.error('[ZaloService] Error fetching group members:', memberErr.message);
                    return sendJson(res, 500, { success: false, error: `Lỗi lấy thành viên nhóm: ${memberErr.message}` });
                }
            }

            // 6.3 Phone check / Find user
            if (action === 'phone-check' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const phoneList = body.phoneList || body.phones || [];
                if (!Array.isArray(phoneList)) return sendJson(res, 400, { error: 'phoneList array required' });

                const results = [];
                for (const rawPhone of phoneList) {
                    const cleanPhone = String(rawPhone).trim();
                    if (!cleanPhone) continue;

                    try {
                        const userRes = await api.findUser(cleanPhone);
                        if (userRes && (userRes.uid || userRes.userId)) {
                            results.push({
                                phone: cleanPhone,
                                found: true,
                                uid: userRes.uid || userRes.userId,
                                name: userRes.displayName || userRes.zaloName || 'Zalo User',
                                avatar: userRes.avatar || '',
                                gender: userRes.gender === 0 ? 'Nam' : (userRes.gender === 1 ? 'Nữ' : 'Khác'),
                                status: 'Đã kích hoạt Zalo'
                            });
                        } else {
                            results.push({
                                phone: cleanPhone,
                                found: false,
                                uid: null,
                                name: '',
                                avatar: '',
                                gender: '',
                                status: 'Chưa đăng ký Zalo'
                            });
                        }
                    } catch (e) {
                        results.push({
                            phone: cleanPhone,
                            found: false,
                            uid: null,
                            name: '',
                            avatar: '',
                            gender: '',
                            status: e.message || 'Không tìm thấy'
                        });
                    }

                    // Small delay between lookups to avoid rate limiting
                    if (phoneList.length > 5) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                }

                return sendJson(res, 200, { success: true, count: results.length, items: results });
            }

            // 6.4 Get All Friends
            if (action === 'friends' && req.method === 'GET') {
                const friendsRes = await api.getAllFriends();
                const list = (friendsRes.data || friendsRes || []);
                const items = Array.isArray(list) ? list.map(f => ({
                    id: f.userId || f.uid,
                    uid: f.userId || f.uid,
                    name: f.displayName || f.zaloName,
                    avatar: f.avatar || '',
                    phone: f.phoneNumber || '',
                    is_friend: true,
                    type: 'person'
                })) : [];
                return sendJson(res, 200, { success: true, count: items.length, items });
            }

            // 6.5 Send Message (Supports Text + Attachment Image/File)
            if (action === 'send-message' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const toId = body.toId || body.to_id;
                const messageText = body.message || body.text || '';
                const attachments = body.attachments || (body.image ? [body.image] : undefined);
                const isGroup = Boolean(body.isGroup);

                if (!toId || (!messageText && (!attachments || !attachments.length))) {
                    return sendJson(res, 400, { error: 'toId and message/attachments required' });
                }

                const threadType = isGroup ? ThreadType.Group : ThreadType.User;
                const payload = attachments && attachments.length ? { msg: messageText, attachments } : messageText;
                const sendRes = await api.sendMessage(payload, toId, threadType);
                return sendJson(res, 200, { success: true, result: sendRes });
            }

            // 6.6 Send Friend Request
            if (action === 'send-friend-request' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const userId = body.userId || body.user_id;
                const message = body.message || 'Xin chào, kết bạn với mình nhé!';
                if (!userId) return sendJson(res, 400, { error: 'userId required' });

                const resFriend = await api.sendFriendRequest(userId, message);
                return sendJson(res, 200, { success: true, result: resFriend });
            }

            // 6.7 Add Members into Group (Kéo mem vào nhóm)
            if (action === 'add-user-to-group' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const groupId = body.groupId || body.group_id;
                const userIds = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
                if (!groupId || !userIds.length) {
                    return sendJson(res, 400, { error: 'groupId and userIds required' });
                }

                const addRes = await api.addUserToGroup(userIds, groupId);
                return sendJson(res, 200, { success: true, result: addRes });
            }

            // 6.8 Auto-Reply / Realtime Message Listener
            if (action === 'listener' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const enable = Boolean(body.enable);
                const rules = body.rules || [];

                if (!enable) {
                    if (activeListeners.has(accountId)) {
                        const l = activeListeners.get(accountId);
                        try { l.stop(); } catch(e) {}
                        activeListeners.delete(accountId);
                    }
                    return sendJson(res, 200, { success: true, listening: false });
                }

                listenerRules.set(accountId, rules);

                if (activeListeners.has(accountId)) {
                    return sendJson(res, 200, { success: true, listening: true, rules_count: rules.length });
                }

                try {
                    const listener = api.listener;
                    listener.start({ retryOnClose: true });
                    activeListeners.set(accountId, listener);

                    listener.on('message', async (msg) => {
                        try {
                            const senderUid = msg.data.uidFrom;
                            const ownUid = api.getOwnId();
                            if (senderUid === ownUid) return;

                            const content = String(msg.data.content || '');
                            console.log(`[ZaloService] Message from ${senderUid} on account ${accountId}: "${content}"`);

                            // Relay message to FastAPI server
                            fetch('http://127.0.0.1:8000/api/zalo-webhook/message', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    account_id: accountId,
                                    from_uid: senderUid,
                                    to_id: msg.threadId,
                                    content: content,
                                    msg_type: msg.data.msgType,
                                    is_group: msg.type === ThreadType.Group
                                })
                            }).catch(() => {});

                            // Match auto-reply rules
                            const currentRules = listenerRules.get(accountId) || [];
                            for (const rule of currentRules) {
                                if (rule.is_active === 0 || rule.is_active === false) continue;
                                const kw = (rule.keyword || '').toLowerCase().trim();
                                const text = content.toLowerCase().trim();
                                let matched = false;

                                if (kw === '*' || rule.match_type === 'all') {
                                    matched = true;
                                } else if (rule.match_type === 'exact') {
                                    matched = (text === kw);
                                } else { // default 'contains'
                                    matched = text.includes(kw);
                                }

                                if (matched && rule.reply_message) {
                                    console.log(`[ZaloService] Auto-replying to ${senderUid} with rule keyword "${kw}"...`);
                                    await api.sendMessage(rule.reply_message, msg.threadId || senderUid, msg.type);
                                    break;
                                }
                            }
                        } catch (err) {
                            console.error('[ZaloService] Listener message handling error:', err.message);
                        }
                    });

                    return sendJson(res, 200, { success: true, listening: true, rules_count: rules.length });
                } catch (lErr) {
                    return sendJson(res, 500, { error: lErr.message });
                }
            }
        }

        // 404
        return sendJson(res, 404, { error: 'Endpoint not found: ' + pathname });

    } catch (globalErr) {
        console.error('[ZaloService] Server error:', globalErr);
        return sendJson(res, 500, { error: globalErr.message || 'Internal server error' });
    }
});

server.listen(PORT, '127.0.0.1', async () => {
    console.log(`[ZaloService] Microservice listening on http://127.0.0.1:${PORT}`);
    // Auto-restore any existing saved sessions
    await autoRestoreAllSavedSessions();
});
