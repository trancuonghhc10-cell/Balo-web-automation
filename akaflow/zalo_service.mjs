import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Zalo,
    ThreadType,
    LoginQRCallbackEventType
} from './vendor/zca-js/dist/index.js';
import { API } from './vendor/zca-js/dist/apis.js';
import { createContext } from './vendor/zca-js/dist/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const SESSIONS_DIR = path.resolve(DATA_DIR, 'zalo_sessions');
const OBSERVATION_QUEUE_PATH = path.resolve(DATA_DIR, 'observed-events.ndjson');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory active sessions, QR login states, and message listeners
const activeSessions = new Map();   // accountId -> API instance
const qrLoginStates = new Map();    // accountId -> { status, qr_image, token, user, error, actions }
const activeListeners = new Map();  // accountId -> listener instance
const listenerRules = new Map();    // accountId -> rules array
const boundListeners = new WeakSet();

function normalizeObservedId(value) {
    const normalized = String(value ?? '').split('_')[0].trim();
    return /^\d+$/.test(normalized) ? normalized : '';
}

function normalizeGroupInviteLink(value) {
    try {
        const url = new URL(String(value ?? '').trim());
        const match = url.pathname.match(/^\/g\/([A-Za-z0-9_-]+)\/?$/);
        if (
            url.protocol !== 'https:' ||
            url.hostname !== 'zalo.me' ||
            url.username ||
            url.password ||
            url.port ||
            !match
        ) {
            return '';
        }
        return `https://zalo.me/g/${match[1]}`;
    } catch {
        return '';
    }
}

async function getMembersViaEnabledGroupLink(api, groupId) {
    if (
        typeof api?.getGroupLinkDetail !== 'function' ||
        typeof api?.getGroupLinkInfo !== 'function'
    ) {
        return null;
    }

    try {
        const detail = await api.getGroupLinkDetail(groupId);
        const link = normalizeGroupInviteLink(detail?.link);
        if (!link || Number(detail?.enabled) !== 1) return null;

        const info = await api.getGroupLinkInfo({ link });
        if (String(info?.groupId || '') !== String(groupId)) {
            console.warn(`[ZaloService] Invite link returned another group for ${groupId}; ignored.`);
            return null;
        }
        return { link, info };
    } catch (err) {
        console.warn(`[ZaloService] Enabled invite-link fallback failed for ${groupId}:`, err.message);
        return null;
    }
}

function queueObservedMember(accountId, groupId, uid, source, details = {}) {
    const normalizedGroupId = normalizeObservedId(groupId);
    const normalizedUid = normalizeObservedId(uid);
    if (!accountId || !normalizedGroupId || !normalizedUid || !source) return;

    const record = {
        account_id: Number(accountId),
        group_id: normalizedGroupId,
        uid: normalizedUid,
        display_name: String(details.display_name || details.name || '').slice(0, 200),
        avatar: String(details.avatar || '').slice(0, 1000),
        source: String(source).slice(0, 100),
        event_at: new Date().toISOString()
    };

    try {
        fs.appendFileSync(
            OBSERVATION_QUEUE_PATH,
            `${JSON.stringify(record)}\n`,
            { encoding: 'utf8', mode: 0o600 }
        );
        fs.chmodSync(OBSERVATION_QUEUE_PATH, 0o600);
    } catch (err) {
        console.warn('[ZaloService] Unable to persist observed member:', err.message);
    }
}

function collectGroupMessage(accountId, msg, source = 'message_sender') {
    if (!msg || msg.type !== ThreadType.Group) return;
    const groupId = msg.threadId || msg.data?.idTo;
    queueObservedMember(accountId, groupId, msg.data?.uidFrom, source, {
        display_name: msg.data?.dName
    });
    for (const mention of (msg.data?.mentions || [])) {
        queueObservedMember(accountId, groupId, mention?.uid, 'mention');
    }
    queueObservedMember(accountId, groupId, msg.data?.quote?.ownerId, 'quote_author', {
        display_name: msg.data?.quote?.fromD
    });
}

function collectReaction(accountId, reaction, source = 'reaction') {
    if (!reaction || !reaction.isGroup) return;
    queueObservedMember(accountId, reaction.threadId || reaction.data?.idTo, reaction.data?.uidFrom, source, {
        display_name: reaction.data?.dName
    });
}

function collectGroupEvent(accountId, event) {
    if (!event) return;
    const data = event.data || {};
    const groupId = data.groupId || data.group_id || event.threadId;
    const source = `group_event:${event.type || event.act || 'unknown'}`;

    queueObservedMember(accountId, groupId, data.sourceId, source);
    queueObservedMember(accountId, groupId, data.creatorId, source);
    queueObservedMember(accountId, groupId, data.actorId, source);
    queueObservedMember(accountId, groupId, data.editorId, source);
    for (const member of (Array.isArray(data.updateMembers) ? data.updateMembers : [])) {
        if (typeof member === 'string' || typeof member === 'number') {
            queueObservedMember(accountId, groupId, member, source);
        } else {
            queueObservedMember(accountId, groupId, member?.id || member?.uid, source, {
                display_name: member?.dName,
                avatar: member?.avatar
            });
        }
    }
    for (const uid of (Array.isArray(data.uids) ? data.uids : [])) {
        queueObservedMember(accountId, groupId, uid, source);
    }
}

async function ensureListener(accountId, api, rules = undefined) {
    if (!api?.listener) return false;
    if (rules !== undefined) listenerRules.set(accountId, rules);
    if (activeListeners.has(accountId)) return true;

    const listener = api.listener;
    if (!boundListeners.has(listener)) {
        listener.on('message', async msg => {
            try {
                collectGroupMessage(accountId, msg);
                const senderUid = normalizeObservedId(msg.data?.uidFrom);
                const ownUid = normalizeObservedId(api.getOwnId());
                if (!senderUid || senderUid === ownUid) return;

                const content = typeof msg.data?.content === 'string' ? msg.data.content : '';
                const currentRules = listenerRules.get(accountId) || [];
                for (const rule of currentRules) {
                    if (rule.is_active === 0 || rule.is_active === false) continue;
                    const keyword = String(rule.keyword || '').toLowerCase().trim();
                    const text = content.toLowerCase().trim();
                    const matched = keyword === '*' || rule.match_type === 'all'
                        || (rule.match_type === 'exact' ? text === keyword : text.includes(keyword));
                    if (matched && rule.reply_message) {
                        await api.sendMessage(rule.reply_message, msg.threadId || senderUid, msg.type);
                        break;
                    }
                }
            } catch (err) {
                console.error('[ZaloService] Listener message handling error:', err.message);
            }
        });
        listener.on('old_messages', (messages, type) => {
            if (type !== ThreadType.Group) return;
            for (const msg of (messages || [])) collectGroupMessage(accountId, msg, 'old_message_sender');
        });
        listener.on('reaction', reaction => collectReaction(accountId, reaction));
        listener.on('old_reactions', (reactions, isGroup) => {
            if (!isGroup) return;
            for (const reaction of (reactions || [])) collectReaction(accountId, reaction, 'old_reaction');
        });
        listener.on('typing', typing => {
            if (typing?.type !== ThreadType.Group) return;
            queueObservedMember(accountId, typing.threadId || typing.data?.gid, typing.data?.uid, 'typing');
        });
        listener.on('seen_messages', messages => {
            for (const item of (messages || [])) {
                if (item?.type !== ThreadType.Group) continue;
                const groupId = item.threadId || item.data?.groupId;
                for (const uid of (item.data?.seenUids || [])) queueObservedMember(accountId, groupId, uid, 'seen_message');
            }
        });
        listener.on('delivered_messages', messages => {
            for (const item of (messages || [])) {
                if (item?.type !== ThreadType.Group) continue;
                const groupId = item.threadId || item.data?.groupId;
                for (const uid of [...(item.data?.deliveredUids || []), ...(item.data?.seenUids || [])]) {
                    queueObservedMember(accountId, groupId, uid, 'delivered_message');
                }
            }
        });
        listener.on('undo', event => {
            if (!event?.isGroup) return;
            queueObservedMember(accountId, event.threadId || event.data?.idTo, event.data?.uidFrom, 'undo', {
                display_name: event.data?.dName
            });
        });
        listener.on('group_event', event => collectGroupEvent(accountId, event));
        listener.on('error', err => console.warn(`[ZaloService] Listener error for account ${accountId}:`, err));
        boundListeners.add(listener);
    }

    listener.start({ retryOnClose: true });
    activeListeners.set(accountId, listener);
    console.log(`[ZaloService] Realtime observation enabled for account ${accountId}`);
    return true;
}

function getSessionFilePath(accountId) {
    return path.join(SESSIONS_DIR, `acc_${accountId}.json`);
}

function saveSessionData(accountId, credentials) {
    const filePath = getSessionFilePath(accountId);
    fs.writeFileSync(filePath, JSON.stringify({
        ...credentials,
        savedAt: new Date().toISOString()
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
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
                    await ensureListener(accountId, api);
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
                try {
                    const api = activeSessions.get(accountId);
                    ownId = api.getOwnId();
                    await ensureListener(accountId, api);
                } catch(e) {}
            }
            return sendJson(res, 200, {
                active: hasActive,
                has_saved_session: hasSaved,
                own_id: ownId,
                listening: activeListeners.has(accountId)
            });
        }

        if (pathname === '/api/session/load' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const accountId = Number(body.account_id);
            const api = await getOrRestoreSession(accountId);
            if (!api) {
                return sendJson(res, 400, { success: false, error: 'Chưa có phiên lưu hoặc phiên hết hạn' });
            }
            await ensureListener(accountId, api);
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

            // 6.1 Get all groups
            if (action === 'groups' && req.method === 'GET') {
                try {
                    console.info(`[Groups] account=${accountId}: calling getAllGroups`);
                    const groupListRes = await api.getAllGroups();

                    if (!groupListRes || typeof groupListRes !== 'object') {
                        throw new Error('getAllGroups returned empty or invalid response');
                    }

                    const groupIds = Object.keys(groupListRes.gridVerMap || {});
                    console.info(`[Groups] account=${accountId}: received ${groupIds.length} group IDs`);

                    if (!groupIds.length) {
                        return sendJson(res, 200, { success: true, count: 0, items: [] });
                    }

                    console.info(`[Groups] account=${accountId}: calling getGroupInfo in chunks of 50 for ${groupIds.length} groups`);
                    const gridInfoMap = {};
                    const chunkSize = 50;
                    for (let i = 0; i < groupIds.length; i += chunkSize) {
                        const chunk = groupIds.slice(i, i + chunkSize);
                        try {
                            const chunkRes = await api.getGroupInfo(chunk);
                            if (chunkRes && chunkRes.gridInfoMap) {
                                Object.assign(gridInfoMap, chunkRes.gridInfoMap);
                            }
                        } catch (chunkErr) {
                            console.warn(`[Groups] account=${accountId}: warning fetching chunk [${i}-${i+chunkSize}]:`, chunkErr.message);
                        }
                    }
                    console.info(`[Groups] account=${accountId}: successfully received ${Object.keys(gridInfoMap).length} group details`);

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
                    console.error('[ZaloService] Error fetching groups:', groupErr.stack || groupErr.message);
                    return sendJson(res, 500, { success: false, error: `Lỗi lấy danh sách nhóm: ${groupErr.message}` });
                }
            }

            // 6.2 Read the member profiles Zalo explicitly exposes for an enabled invite link.
            // This never enables a link and never guesses link tokens.
            if (action === 'group-link-members' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const link = normalizeGroupInviteLink(body.link);
                if (!link) {
                    return sendJson(res, 400, {
                        success: false,
                        error: 'Link nhóm không hợp lệ. Hãy dùng dạng https://zalo.me/g/...'
                    });
                }
                if (typeof api.getGroupLinkInfo !== 'function') {
                    return sendJson(res, 501, {
                        success: false,
                        error: 'Phiên bản kết nối Zalo hiện tại chưa hỗ trợ đọc link nhóm.'
                    });
                }

                try {
                    const info = await api.getGroupLinkInfo({ link });
                    const ownId = normalizeObservedId(
                        typeof api.getOwnId === 'function' ? api.getOwnId() : ''
                    );
                    const creatorId = normalizeObservedId(info?.creatorId);
                    const adminIds = new Set(
                        (Array.isArray(info?.adminIds) ? info.adminIds : [])
                            .map(normalizeObservedId)
                            .filter(Boolean)
                    );
                    const seen = new Set();
                    const items = [];
                    for (const member of (Array.isArray(info?.currentMems) ? info.currentMems : [])) {
                        const uid = normalizeObservedId(member?.id);
                        if (!uid || uid === ownId || seen.has(uid)) continue;
                        seen.add(uid);
                        items.push({
                            id: uid,
                            uid,
                            name: String(member?.dName || member?.zaloName || `Người dùng ${uid}`).trim(),
                            zalo_name: String(member?.zaloName || '').trim(),
                            avatar: String(member?.avatar || ''),
                            role: uid === creatorId
                                ? 'Trưởng nhóm'
                                : (adminIds.has(uid) ? 'Phó nhóm' : 'Thành viên qua link mời'),
                            is_admin: uid === creatorId || adminIds.has(uid),
                            type: 'member'
                        });
                    }
                    const hasMore = Boolean(Number(info?.hasMoreMember));
                    const totalMembers = Number(info?.totalMember || items.length);
                    const memberListWithheld = totalMembers > 0 && items.length === 0;
                    return sendJson(res, 200, {
                        success: true,
                        group_id: String(info?.groupId || ''),
                        group_name: String(info?.name || info?.groupId || ''),
                        total_members: totalMembers,
                        resolved_members: items.length,
                        member_source: 'enabled_group_link',
                        complete: !hasMore && !memberListWithheld,
                        has_more: hasMore,
                        access_limited: memberListWithheld,
                        message: memberListWithheld
                            ? `Link hợp lệ và Zalo nhận diện nhóm có ${totalMembers} thành viên, nhưng máy chủ không cung cấp danh sách thành viên cho phiên này.`
                            : (hasMore
                                ? `Link hợp lệ: Zalo trả ${items.length} thành viên ở trang đầu; nhóm còn dữ liệu chưa được trả về.`
                                : `Link hợp lệ: Zalo cho phép xem ${items.length} thành viên qua link mời đang bật.`),
                        items
                    });
                } catch (linkErr) {
                    console.warn('[ZaloService] Group invite link lookup failed:', linkErr.message);
                    return sendJson(res, 400, {
                        success: false,
                        error: `Không đọc được link nhóm: ${linkErr.message}`
                    });
                }
            }

            // 6.3 Get Group Members (only for groups where member list is accessible)
            if (action === 'group-members' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const groupId = body.groupId || body.group_id;
                const extraUids = Array.isArray(body.extraUids)
                    ? body.extraUids.map(s => String(s).split('_')[0].trim()).filter(Boolean)
                    : [];
                if (!groupId) return sendJson(res, 400, { error: 'groupId required' });

                try {
                    console.log(`[ZaloService] Fetching members for group ${groupId}...`);
                    const groupInfoRes = await api.getGroupInfo(groupId);
                    const groupInfo = (groupInfoRes.gridInfoMap && groupInfoRes.gridInfoMap[groupId]) || {};
                    
                    const normalizeUid = (value) =>
                        String(value ?? '').split('_')[0].trim();

                    const adminIds = Array.isArray(groupInfo.adminIds)
                        ? groupInfo.adminIds.map(normalizeUid).filter(Boolean)
                        : [];

                    const creatorId = normalizeUid(groupInfo.creatorId);
                    const ownId = normalizeUid(
                        typeof api.getOwnId === 'function' ? api.getOwnId() : ''
                    );

                    const isAdmin = Boolean(
                        ownId && (ownId === creatorId || adminIds.includes(ownId))
                    );

                    const isHidden = Number(
                        groupInfo.setting?.lockViewMember ?? 0
                    ) === 1;

                    console.log('[Group Permission]', {
                        groupId, ownId, creatorId, isAdmin, isHidden
                    });

                    let memberUids = [];
                    let memberSource = 'none';
                    const memberRoleMap = new Map();
                    const embeddedProfiles = {};
                    let linkFallback = null;

                    for (const member of (
                        Array.isArray(groupInfo.currentMems) ? groupInfo.currentMems : []
                    )) {
                        const uid = normalizeUid(member?.id);
                        if (!uid) continue;
                        embeddedProfiles[uid] = {
                            displayName: member?.dName || '',
                            zaloName: member?.zaloName || '',
                            avatar: member?.avatar || ''
                        };
                    }

                    if (creatorId) memberRoleMap.set(creatorId, 'Trưởng nhóm');
                    adminIds.forEach(id => {
                        if (!memberRoleMap.has(id)) memberRoleMap.set(id, 'Phó nhóm');
                    });

                    if (isAdmin || !isHidden) {
                        // Authorized/visible roster: combine UID and embedded-profile fields.
                        const visibleMemberIds = Array.isArray(groupInfo.memberIds)
                            ? groupInfo.memberIds
                            : [];
                        const allowedMemberVersions = (
                            (!isHidden || isAdmin) &&
                            Array.isArray(groupInfo.memVerList)
                        ) ? groupInfo.memVerList : [];
                        const embeddedMemberIds = Object.keys(embeddedProfiles);
                        const rawMemberIds = [
                            ...visibleMemberIds,
                            ...embeddedMemberIds,
                            ...allowedMemberVersions
                        ];

                        memberSource = visibleMemberIds.length
                            ? 'memberIds'
                            : (embeddedMemberIds.length
                                ? 'currentMems'
                                : (allowedMemberVersions.length ? 'memVerList-authorized' : 'admin_roster'));

                        const extracted = rawMemberIds
                            .map(normalizeUid)
                            .filter(Boolean);

                        memberUids = [...new Set([
                            creatorId,
                            ...adminIds,
                            ...extracted
                        ])].filter(Boolean);

                        extracted.forEach(uid => {
                            if (!memberRoleMap.has(uid)) {
                                memberRoleMap.set(uid, 'Thành viên');
                            }
                        });

                        if (extracted.length === 0 && Number(groupInfo.totalMember || 0) > memberUids.length) {
                            linkFallback = await getMembersViaEnabledGroupLink(api, groupId);
                        }
                    } else {
                        // Non-admin in hidden group: extract authorized public & interactive members
                        memberSource = 'public_interactive';

                        // An enabled invite link is a separate server-authorized view. Never enable it here.
                        linkFallback = await getMembersViaEnabledGroupLink(api, groupId);

                        // 1. Scan Group Board & Polls
                        if (typeof api.getListBoard === 'function') {
                            try {
                                let page = 1;
                                const maxPages = 3;
                                while (page <= maxPages) {
                                    const board = await api.getListBoard({ page, count: 50 }, groupId);
                                    const boardItems = board?.items || [];
                                    if (!boardItems.length) break;

                                    for (const it of boardItems) {
                                        const d = it.data || it;
                                        const noteCreator = normalizeUid(d.creatorId || d.creator);
                                        if (noteCreator && !memberRoleMap.has(noteCreator)) {
                                            memberRoleMap.set(noteCreator, 'Tác giả bài ghim/bảng tin');
                                        }
                                        const editor = normalizeUid(d.editorId);
                                        if (editor && !memberRoleMap.has(editor)) {
                                            memberRoleMap.set(editor, 'Biên tập bài ghim');
                                        }
                                        const sender = normalizeUid(d.params?.senderUid || d.params?.creator_id);
                                        if (sender && !memberRoleMap.has(sender)) {
                                            memberRoleMap.set(sender, 'Thành viên đăng bài');
                                        }

                                        if (Array.isArray(d.likers)) {
                                            for (const liker of d.likers) {
                                                const lUid = normalizeUid(typeof liker === 'object' ? (liker.uid || liker.id) : liker);
                                                if (lUid && !memberRoleMap.has(lUid)) {
                                                    memberRoleMap.set(lUid, 'Thành viên tương tác (Thích)');
                                                }
                                            }
                                        }

                                        if (Array.isArray(d.options)) {
                                            for (const opt of d.options) {
                                                if (Array.isArray(opt.voters)) {
                                                    for (const voter of opt.voters) {
                                                        const vUid = normalizeUid(typeof voter === 'object' ? (voter.uid || voter.id) : voter);
                                                        if (vUid && !memberRoleMap.has(vUid)) {
                                                            memberRoleMap.set(vUid, 'Thành viên tương tác (Bình chọn)');
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    page++;
                                }
                            } catch (boardErr) {
                                console.warn(`[ZaloService] Board scan notice for group ${groupId}:`, boardErr.message);
                            }
                        }

                        // 2. Scan recent conversation history
                        if (typeof api.getGroupChatHistory === 'function') {
                            try {
                                const history = await api.getGroupChatHistory(groupId, 50);
                                const msgs = history?.groupMsgs || [];
                                for (const m of msgs) {
                                    const senderUid = normalizeUid(m.uidFrom);
                                    if (senderUid && !memberRoleMap.has(senderUid)) {
                                        memberRoleMap.set(senderUid, 'Thành viên nhắn tin gần đây');
                                    }
                                }
                            } catch (historyErr) {
                                console.warn(`[ZaloService] Chat history scan notice for group ${groupId}:`, historyErr.message);
                            }
                        }

                        memberUids = Array.from(memberRoleMap.keys()).filter(Boolean);
                    }

                    if (linkFallback?.info) {
                        const linkedMembers = Array.isArray(linkFallback.info.currentMems)
                            ? linkFallback.info.currentMems
                            : [];
                        for (const member of linkedMembers) {
                            const uid = normalizeUid(member?.id);
                            if (!uid || uid === ownId) continue;
                            embeddedProfiles[uid] = {
                                displayName: member?.dName || '',
                                zaloName: member?.zaloName || '',
                                avatar: member?.avatar || ''
                            };
                            if (!memberRoleMap.has(uid)) {
                                memberRoleMap.set(uid, 'Thành viên qua link mời');
                            }
                        }
                        memberUids = [...new Set([
                            ...memberUids,
                            ...Object.keys(embeddedProfiles)
                        ])].filter(Boolean);
                        if (linkedMembers.length) memberSource = 'enabled_group_link';
                    }

                    const normalizedCreatorId = String(creatorId || '');
                    const normalizedAdminIds = new Set(
                        adminIds.map(id => String(id))
                    );

                    console.log(
                        `[ZaloService] Group ${groupId}: processing ${memberUids.length} accessible member UIDs from ${memberSource}.`
                    );

                    // Fetch profiles in batches of at most 50 (including any historical observed UIDs).
                    const allUidsToFetch = [...new Set([...memberUids, ...extraUids])];
                    const profiles = { ...embeddedProfiles };
                    const chunkSize = 50;

                    for (let i = 0; i < allUidsToFetch.length; i += chunkSize) {
                        const chunk = allUidsToFetch.slice(i, i + chunkSize);

                        try {
                            if (typeof api.getUserInfo === 'function') {
                                const userRes = await api.getUserInfo(chunk);

                                if (userRes && userRes.changed_profiles) {
                                    for (const [key, profile] of Object.entries(userRes.changed_profiles)) {
                                        const uid = String(key).replace(/_0$/, '').trim();
                                        if (uid) profiles[uid] = profile;
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn(
                                `[ZaloService] getUserInfo batch ${i} failed:`,
                                err.message
                            );
                        }
                    }

                    const items = memberUids.map(uid => {
                        const p = profiles[uid] || {};
                        let role = memberRoleMap.get(uid) || 'Thành viên';
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
                            is_admin: uid === normalizedCreatorId || normalizedAdminIds.has(uid),
                            type: 'member'
                        };
                    });

                    let statusMessage = '';
                    if (memberSource === 'enabled_group_link') {
                        statusMessage = Boolean(Number(linkFallback?.info?.hasMoreMember))
                            ? `Link mời đang bật: Zalo trả ${items.length} thành viên ở trang đầu; kết quả chưa phải toàn bộ nhóm.`
                            : `Link mời đang bật: Zalo cho phép xem ${items.length} thành viên qua link.`;
                    } else if (isAdmin) {
                        statusMessage = isHidden
                            ? `Quản trị viên: Đã đọc ${items.length} thành viên từ danh mục được Zalo cấp quyền.`
                            : `Đã tải ${items.length} thành viên nhóm.`;
                    } else if (isHidden) {
                        statusMessage = items.length > 0
                            ? `Nhóm đã bật ẩn danh sách thành viên: Đã trích xuất ${items.length} thành viên công khai và tương tác (Ban quản trị, bình chọn, bài ghim, tin nhắn).`
                            : `Nhóm "${groupInfo.name || groupId}" đã bật ẩn danh sách thành viên và chưa có tương tác công khai nào.`;
                    } else {
                        statusMessage = `Đã tải ${items.length} thành viên nhóm.`;
                    }

                    return sendJson(res, 200, {
                        success: true,
                        group_id: groupId,
                        group_name: groupInfo.name || groupId,
                        is_hidden_members: isHidden,
                        total_members: groupInfo.totalMember || memberUids.length,
                        resolved_members: memberUids.length,
                        member_source: memberSource,
                        complete: memberSource === 'enabled_group_link'
                            ? !Boolean(Number(linkFallback?.info?.hasMoreMember))
                            : true,
                        has_more: memberSource === 'enabled_group_link'
                            ? Boolean(Number(linkFallback?.info?.hasMoreMember))
                            : false,
                        message: statusMessage,
                        items: items,
                        resolved_profiles: profiles
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

                try {
                    await ensureListener(accountId, api, rules);
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
