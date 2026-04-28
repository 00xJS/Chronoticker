// Netlify serverless proxy for keyless stock historical price data.
//
// Why this exists:
//   - Browsers can't call Yahoo Finance directly (CORS).
//   - Public CORS proxies (corsproxy.io etc.) get IP-banned by Yahoo.
//   - Yahoo aggressively rate-limits Netlify's edge IPs (HTTP 429).
//
// Strategy: try multiple upstream sources, return the first one that
// works, all reshaped into Yahoo's chart-API JSON so the frontend
// doesn't need to know which source the data came from.
//
// Sources, in priority order:
//   1. Stooq — keyless CSV historical data, generous rate limits.
//      The most reliable upstream for US-listed stocks/ETFs.
//   2. Yahoo Finance v8 chart endpoint — better adjusted-close handling
//      (dividends), but rate-limits aggressively from cloud IPs.
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

// ── Source 1: Stooq ─────────────────────────────────────────────────
// Returns CSV with Date,Open,High,Low,Close,Volume. We map the symbol
// to Stooq's `<sym>.us` form, fetch the CSV, parse Date + Close, and
// reshape into Yahoo's chart response format.
async function fetchStooq(symbol, range) {
    const days  = RANGE_TO_DAYS[range] || 366;
    const end   = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const stooqSym = `${symbol.toLowerCase()}.us`;
    const url = `https://stooq.com/q/d/l/?s=${stooqSym}` +
                `&d1=${ymd(start)}&d2=${ymd(end)}&i=d`;

    const res = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Accept':     'text/csv, text/plain, */*',
        },
    });
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);

    const csv = (await res.text()).trim();
    if (!csv || /^no data/i.test(csv) || csv.length < 30) {
        throw new Error('Stooq: empty or "no data" response');
    }

    const lines  = csv.split(/\r?\n/);
    const header = lines[0].split(',').map(s => s.trim());
    const dateIdx  = header.indexOf('Date');
    const closeIdx = header.indexOf('Close');
    if (dateIdx < 0 || closeIdx < 0) {
        throw new Error('Stooq: unexpected CSV header');
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

    if (!timestamps.length) throw new Error('Stooq: no rows parsed');

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

// ── Source 2: Yahoo Finance v8 chart endpoint ───────────────────────
// Better data quality (adjusted close handles dividends correctly)
// but rate-limits Netlify IPs aggressively. Used as fallback when
// Stooq fails (e.g., for symbols Stooq doesn't carry).
async function fetchYahoo(symbol, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${range}` +
        `&interval=1d&includeAdjustedClose=true`;

    const res = await fetch(url, {
        headers: {
            'User-Agent':      UA,
            'Accept':          'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer':         'https://finance.yahoo.com/',
        },
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp) throw new Error('Yahoo: empty result');
    if (r.meta) r.meta.dataSource = 'yahoo';
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

    // Try Stooq first — most reliable for US-listed equities/ETFs.
    try {
        const data = await fetchStooq(symbol, range);
        return jsonResponse(200, data);
    } catch (err) {
        errors.push(`stooq: ${err.message || err}`);
    }

    // Fall back to Yahoo.
    try {
        const data = await fetchYahoo(symbol, range);
        return jsonResponse(200, data);
    } catch (err) {
        errors.push(`yahoo: ${err.message || err}`);
    }

    return jsonResponse(502, {
        error:  'All upstream sources failed',
        detail: errors,
        symbol,
        range,
    });
};
