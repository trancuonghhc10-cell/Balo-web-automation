import crypto from 'node:crypto';

/**
 * Build cookie header string for a given URL from Zalo session cookies.
 * @param {Array} cookies - array of cookie objects from session
 * @param {string} url - target request URL
 * @returns {string}
 */
function buildCookie(cookies, url) {
    if (!cookies || !Array.isArray(cookies)) return '';
    const { hostname } = new URL(url);
    return cookies
        .filter(c => {
            const domain = c.domain || '';
            const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain;
            return hostname.endsWith(cleanDomain) || hostname === cleanDomain;
        })
        .map(c => `${c.name || c.key}=${c.value}`)
        .join('; ');
}

/** AES-CBC encrypt plain text using Zalo's zpw_enk key */
function aesEncrypt(plaintext, zpwEnk) {
    const key = Buffer.from(zpwEnk, 'base64');
    const iv = Buffer.alloc(16, 0);
    const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
    const cipher = crypto.createCipheriv(algo, key, iv);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

/** AES-CBC decrypt Zalo's encrypted response */
function aesDecrypt(ciphertext, zpwEnk) {
    const key = Buffer.from(zpwEnk, 'base64');
    const iv = Buffer.alloc(16, 0);
    const algo = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
    const decipher = crypto.createDecipheriv(algo, key, iv);
    const ct = Buffer.from(decodeURIComponent(ciphertext), 'base64');
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Fallback request to profile-wpa.zaloapp.com API (encrypted).
 * @param {Array<string>} uids - array of raw UID strings (no "_0" suffix)
 * @param {object} api - active Zalo API instance (used to get cookies, imei, zpw_enk)
 * @returns {Promise<object|null>} parsed JSON response or null on error
 */
export async function fetchProfileWpa(uids, api) {
    try {
        const ctx = api.listener?.ctx;
        if (!ctx) return null;
        const imei = ctx.imei;
        const cookieJar = ctx.cookie;
        const cookies = cookieJar?.toJSON?.().cookies || [];
        
        let zpwEnk = ctx.secretKey || cookies.find(c => (c.name || c.key) === 'zpw_enk')?.value;
        if (!zpwEnk) {
            console.warn('[profile_wpa_helper] Missing zpw_enk for AES encryption');
            return null;
        }

        const url = 'https://profile-wpa.zaloapp.com/api/social/group/members';
        const friendPversionMap = uids.map(u => (u.endsWith('_0') ? u : `${u}_0`));
        const encBody = aesEncrypt(JSON.stringify({ friend_pversion_map: friendPversionMap }), zpwEnk);

        const queryParams = new URLSearchParams({
            zpw_type: String(ctx.API_TYPE || '30'),
            zpw_ver: String(ctx.API_VERSION || '671'),
            imei: imei || ''
        });

        const fullUrl = `${url}?${queryParams.toString()}`;
        const cookieHeader = buildCookie(cookies, fullUrl);

        const resp = await fetch(fullUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': ctx.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1',
                'Cookie': cookieHeader
            },
            body: `params=${encodeURIComponent(encBody)}`
        });

        if (!resp.ok) {
            console.warn(`[profile_wpa_helper] Request failed: HTTP ${resp.status}`);
            return null;
        }

        const json = await resp.json();
        if (!json.data) return null;

        const decrypted = aesDecrypt(json.data, zpwEnk);
        return JSON.parse(decrypted);
    } catch (e) {
        console.error('[profile_wpa_helper] Error in fetchProfileWpa:', e.message);
        return null;
    }
}
