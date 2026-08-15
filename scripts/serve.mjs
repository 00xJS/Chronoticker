#!/usr/bin/env node
// Minimal static server for local development.
//
//   node scripts/serve.mjs [port]     → http://localhost:8177
//
// Opening index.html as a file:// URL no longer works: the app is an ES
// module and imports assets/engine.js, which browsers refuse to load
// cross-origin from the filesystem. It also fetches data/*.json. Both need
// a real origin, so this exists to save reaching for Python.
//
// Zero dependencies, Node 18+.

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8177;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.csv':  'text/csv; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith('/')) rel += 'index.html';

        // Resolve inside ROOT and refuse anything that escapes it.
        const file = path.resolve(ROOT, '.' + rel);
        if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        const body = await fs.readFile(file);
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            // Never cache during development — stale data files are the
            // single most confusing thing that can happen while iterating.
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch (err) {
        const code = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(code === 404 ? `Not found: ${req.url}` : `Error: ${err.message}`);
    }
});

server.listen(PORT, () => {
    console.log(`Chronoticker → http://localhost:${PORT}`);
    console.log(`Serving ${ROOT}`);
});
