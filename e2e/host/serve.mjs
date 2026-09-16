import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.HOST_PAGE_PORT || '5390');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serves the AppBridge test host page and its esbuild bundle
 * (e2e/host/dist/bundle.js, produced by `npm run build:e2e-host`).
 */
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urlPath = (req.url ?? '/').split('?')[0];
  const relativePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, relativePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`e2e host page listening on http://localhost:${port}`);
});
