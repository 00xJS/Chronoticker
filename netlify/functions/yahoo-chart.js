// Netlify serverless proxy for keyless stock historical price data.
//
// Sources tried in priority order:
//   1. Stooq           — keyless CSV (most reliable when it works).
//   2. Yahoo + crumb   — cookie + crumb auth flow Yahoo's own UI uses.
//                        Often gets past the 429 wall that hits direct
//                        unauthenticated calls from cloud IPs.
//   3. Yahoo direct    — last resort, frequently 429s from Netlify IPs.
//
// All sources reshape into Yahoo chart-API JSON so the frontend stays
// source-agnostic.
//
// Endpoint:  /api/chart?symbol=AAPL&range=1y
// Allowed ranges: 1mo 3mo 6mo ytd 1y 2y 5y 10y max

const ALLOWED_RANGES = new Set([
    '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max',
]);

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,16}$/i;

const RANGE_TO_DAYS = {
    '1mo': 31,  '3mo': 92,  '6mo': 183, 'ytd': 365,
    '1y':  366, '2y':  731, '5y':  1827, '10y': 3653,
    'max': 9999,
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,text/csv,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control':                'public, max-age=300, s-maxage=300',
};

function jsonResponse(statusCode, payload) {
    return {
        statusCode,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
}

function ymd(date) {
    return `${date.getUTCFullYear()}` +
           `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
           `${String(date.getUTCDate()).padStart(2, '0')}`;
}

function snippet(s, n = 180) {
    return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

// ── Source 1: Stooq ─────────────────────────────────────────────────
async function fetchStooq(symbol, range) {
    const days  = RANGE_TO_DAYS[range] || 366;
    const end   = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const stooqSym = `${symbol.toLowerCase()}.us`;
    const url = `https://stooq.com/q/d/l/?s=${stooqSym}` +
                `&d1=${ymd(start)}&d2=${ymd(end)}&i=d`;

    const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, 'Referer': 'https://stooq.com/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.text()).trim();
    if (!body) throw new Error('empty response');
    if (/^</.test(body)) throw new Error(`HTML not CSV: "${snippet(body)}"`);
    if (/^no data/i.test(body) || body.length < 30) {
        throw new Error(`no-data response: "${snippet(body)}"`);
    }

    const lines  = body.split(/\r?\n/);
    const header = lines[0].split(',').map(s => s.trim().toLowerCase());
    const dateIdx  = header.indexOf('date');
    const closeIdx = header.indexOf('close');
    if (dateIdx < 0 || closeIdx < 0) {
        throw new Error(`unexpected CSV header: "${snippet(body)}"`);
    }

    const timestamps = [];
    const closes     = [];
    for (let i = 1; i < lines.length; i++) {
        const cells   = lines[i].split(',');
        const dateStr = cells[dateIdx];
        const cStr    = cells[closeIdx];
        if (!dateStr || !cStr) continue;
        const t = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
        const c = parseFloat(cStr);
        if (Number.isFinite(t) && Number.isFinite(c)) {
            timestamps.push(t);
            closes.push(c);
        }
    }
    if (!timestamps.length) throw new Error('no rows parsed');

    return {
        chart: {
            result: [{
                meta: {
                    symbol:     symbol.toUpperCase(),
                    range,
                    currency:   'USD',
                    dataSource: 'stooq',
                },
                timestamp: timestamps,
                indicators: {
                    quote:    [{ close: closes }],
                    adjclose: [{ adjclose: closes }],
                },
            }],
            error: null,
        },
    };
}

// ── Source 2: Yahoo with cookie + crumb ─────────────────────────────
// Mirrors what finance.yahoo.com does in the browser. Often gets past
// the 429 wall that hits direct anonymous calls from cloud IPs.
async function fetchYahooCrumb(symbol, range) {
    // 1. Hit fc.yahoo.com to get session cookies (A1, A1S, A3).
    const sessionRes = await fetch('https://fc.yahoo.com', {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
    });
    const rawSetCookie = sessionRes.headers.get('set-cookie') || '';
    if (!rawSetCookie) throw new Error('no session cookies received');

    // Header may be a comma-joined string of multiple Set-Cookie values.
    // Split conservatively: comma followed by a cookie name=.
    const cookies = rawSetCookie
        .split(/,(?=\s*[A-Za-z0-9_!#$&'*+\-.^`|~]+=)/)
        .map(c => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    if (!cookies) throw new Error('failed to parse session cookies');

    // 2. Fetch a crumb from getcrumb endpoint, using the cookies.
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { ...BROWSER_HEADERS, 'Cookie': cookies, 'Referer': 'https://finance.yahoo.com/' },
    });
    if (!crumbRes.ok) throw new Error(`crumb HTTP ${crumbRes.status}`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 64) throw new Error(`bad crumb: "${snippet(crumb, 64)}"`);

    // 3. Hit the chart endpoint with the cookie + crumb in tow.
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${range}&interval=1d&includeAdjustedClose=true` +
        `&crumb=${encodeURIComponent(crumb)}`;
    const chartRes = await fetch(chartUrl, {
        headers: {
            ...BROWSER_HEADERS,
            'Accept':  'application/json, text/plain, */*',
            'Cookie':  cookies,
            'Referer': 'https://finance.yahoo.com/',
        },
    });
    if (!chartRes.ok) throw new Error(`chart HTTP ${chartRes.status}`);
    const json = await chartRes.json();
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp) throw new Error('empty result');
    if (r.meta) r.meta.dataSource = 'yahoo-crumb';
    return json;
}

// ── Source 3: Yahoo direct (no auth) ────────────────────────────────
async function fetchYahooDirect(symbol, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${range}` +
        `&interval=1d&includeAdjustedClose=true`;
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            'Accept':  'application/json, text/plain, */*',
            'Referer': 'https://finance.yahoo.com/',
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp) throw new Error('empty result');
    if (r.meta) r.meta.dataSource = 'yahoo-direct';
    return json;
}

// ── Handler ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return jsonResponse(405, { error: 'Method Not Allowed' });
    }

    const params = event.queryStringParameters || {};
    const symbol = (params.symbol || '').trim();
    const range  = (params.range  || '1y').trim();

    if (!SYMBOL_RE.test(symbol)) {
        return jsonResponse(400, { error: 'Invalid or missing `symbol` parameter' });
    }
    if (!ALLOWED_RANGES.has(range)) {
        return jsonResponse(400, {
            error:   'Invalid `range` parameter',
            allowed: [...ALLOWED_RANGES],
        });
    }

    const errors = [];
    const sources = [
        ['stooq',        () => fetchStooq(symbol, range)],
        ['yahoo-crumb',  () => fetchYahooCrumb(symbol, range)],
        ['yahoo-direct', () => fetchYahooDirect(symbol, range)],
    ];

    for (const [name, fn] of sources) {
        try {
            const data = await fn();
            return jsonResponse(200, data);
        } catch (err) {
            errors.push(`${name}: ${err.message || err}`);
        }
    }

    return jsonResponse(502, {
        error:  'All upstream sources failed',
        detail: errors,
        symbol,
        range,
    });
};
