// Netlify serverless proxy for the public Yahoo Finance chart endpoint.
//
// Why this exists: browsers can't call query1.finance.yahoo.com directly
// (CORS) and public CORS proxies (corsproxy.io, allorigins, etc.) get
// IP-blocked by Yahoo's anti-bot system, returning 403/429. By running
// our own proxy on Netlify's edge with a real-looking User-Agent, Yahoo
// treats the request as a normal browser hit. Free, keyless, reliable.
//
// Endpoint:  /api/chart?symbol=AAPL&range=1y
// Routes through netlify.toml redirect to /.netlify/functions/yahoo-chart.

const ALLOWED_RANGES = new Set([
    '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max',
]);

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,16}$/i; // covers AAPL, BRK-B, BTC-USD, ^GSPC, etc.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Cache successful responses at the edge for 5 min — historical
    // daily data doesn't change intraday and this protects against
    // accidental rapid-fire calls.
    'Cache-Control':                'public, max-age=300, s-maxage=300',
};

function jsonResponse(statusCode, payload) {
    return {
        statusCode,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
}

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
        return jsonResponse(400, { error: `Invalid \`range\`. Allowed: ${[...ALLOWED_RANGES].join(', ')}` });
    }

    const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?range=${range}&interval=1d&includeAdjustedClose=true`;

    try {
        const res = await fetch(upstream, {
            headers: {
                // Real-looking browser UA — Yahoo blocks generic / curl / Node defaults.
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept':          'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer':         'https://finance.yahoo.com/',
            },
        });

        const body = await res.text();

        if (!res.ok) {
            return jsonResponse(res.status, {
                error: `Upstream Yahoo Finance returned ${res.status}`,
                symbol,
                range,
            });
        }

        return {
            statusCode: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            body,
        };
    } catch (err) {
        return jsonResponse(502, {
            error: 'Upstream fetch failed',
            detail: err.message || String(err),
        });
    }
};
