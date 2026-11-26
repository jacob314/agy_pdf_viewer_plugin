import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type {
  LoadPdfChunkResponse,
  PdfFileViewerPayload,
  PdfSessionPayload,
  PdfSlotMeta,
  PromotePdfResponse,
  ResolvePdfSourceResponse,
  SavePdfResponse,
  ViewMode,
  ViewerLayout,
  ZoomMode,
} from '../shared/types.js';

const APP_URI = 'ui://pdf-viewer/app.html';
// 512 KiB raw -> ~699 KiB base64 JSON, safely below Antigravity's 1 MiB MCP payload cap
const CHUNK_SIZE_BYTES = 524_288;
const PROMOTED_SESSION_TTL_MS = 30_000;
const MAX_REGISTRY_ENTRIES = 150;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

let DATA_DIR = path.join(PLUGIN_ROOT, '.data');
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--data-dir=')) {
    DATA_DIR = arg.slice('--data-dir='.length);
  }
}

interface RegisteredPdf {
  id: string;
  absPath: string;
  meta: PdfSlotMeta;
}

interface PersistedRegistryEntry {
  id: string;
  absPath: string;
  label: string;
  fileName: string;
}

interface PersistedSession {
  title: string;
  activeIndex: number;
  viewMode: ViewMode;
  zoomMode: ZoomMode;
  inlineHeight: number;
  files: Array<{ path: string; label?: string; page?: number }>;
}

interface PromotedSession {
  createdAt: number;
  activeFileName: string;
  payload: PdfSessionPayload;
}

const STREAM_TOKEN = crypto.randomBytes(24).toString('hex');
let streamOrigin: string | null = null;

const registeredPdfs = new Map<string, RegisteredPdf>();
const pendingSaveUploads = new Map<string, Buffer[]>();
let pendingPromotedSession: PromotedSession | null = null;

function appendDebugLog(scope: string, detail: unknown): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const logFile = path.join(DATA_DIR, 'debug.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 128_000) {
      fs.writeFileSync(logFile, '', 'utf8');
    }
    const line = `${new Date().toISOString()} [${scope}] ${
      typeof detail === 'string' ? detail : JSON.stringify(detail)
    }\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // Non-fatal
  }
}

function buildStreamUrl(pdfId: string, mtimeMs: number): string | undefined {
  if (!streamOrigin) return undefined;
  return `${streamOrigin}/pdf/${STREAM_TOKEN}/${pdfId}?v=${Math.floor(mtimeMs)}`;
}

function registryPath(): string {
  return path.join(DATA_DIR, 'registry.json');
}

function lastSessionPath(): string {
  return path.join(DATA_DIR, 'last_session.json');
}

function makePdfId(absPath: string): string {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

function registerSingleDiskPdf(absPath: string, label?: string, initialPage = 1): PdfSlotMeta {
  const resolved = path.resolve(absPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PDF file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`Unsupported file type "${ext}" for ${path.basename(resolved)}. Expected .pdf`);
  }

  const id = makePdfId(resolved);
  const fileName = path.basename(resolved);
  const cleanLabel = (label && label.trim()) || fileName.replace(/\.pdf$/i, '');
  const meta: PdfSlotMeta = {
    id,
    label: cleanLabel,
    fileName,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    initialPage: Math.max(1, Math.floor(initialPage || 1)),
    streamUrl: buildStreamUrl(id, stat.mtimeMs),
  };

  // Re-insert so most recently used is always at the end
  registeredPdfs.delete(id);
  registeredPdfs.set(id, { id, absPath: resolved, meta });
  return meta;
}

function saveRegistry(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries: PersistedRegistryEntry[] = Array.from(registeredPdfs.values())
      .slice(-MAX_REGISTRY_ENTRIES)
      .map((r) => ({
        id: r.id,
        absPath: r.absPath,
        label: r.meta.label,
        fileName: r.meta.fileName,
      }));
    fs.writeFileSync(registryPath(), JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function loadRegistry(): void {
  try {
    const p = registryPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(raw)) {
        for (const entry of raw as PersistedRegistryEntry[]) {
          if (!entry || typeof entry.absPath !== 'string' || !fs.existsSync(entry.absPath)) continue;
          try {
            registerSingleDiskPdf(entry.absPath, entry.label, 1);
          } catch {
            // Skip unreadable entries
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Also seed from last_session.json so files opened before registry.json existed are immediately known
  try {
    const prev = loadLastSession();
    if (prev) {
      let seeded = false;
      for (const f of prev.files) {
        if (f?.path && fs.existsSync(f.path)) {
          try {
            registerSingleDiskPdf(f.path, f.label, f.page ?? 1);
            seeded = true;
          } catch {
            // Ignore
          }
        }
      }
      if (seeded) saveRegistry();
    }
  } catch {
    // Non-fatal
  }
}

function saveLastSession(session: PersistedSession): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(lastSessionPath(), JSON.stringify(session, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function loadLastSession(): PersistedSession | null {
  try {
    const p = lastSessionPath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || !Array.isArray(raw.files)) return null;
    const existing = raw.files.filter(
      (f: { path?: string }) => typeof f?.path === 'string' && fs.existsSync(f.path),
    );
    if (existing.length === 0) return null;
    return { ...raw, files: existing.slice(0, 5) };
  } catch {
    return null;
  }
}

function pickNonClobberingDownloadsPath(rawFileName: string): string {
  const baseName = path.basename(rawFileName || 'document.pdf');
  const rawStem = baseName.replace(/\.pdf$/i, '');
  const safeStem = rawStem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  let candidate = path.join(downloadsDir, `${safeStem}.pdf`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsDir, `${safeStem}_${n}.pdf`);
    n++;
  }
  return candidate;
}

function tryResolveLocalPdfPath(file: Record<string, unknown> & {
  name: string;
  resourceUri?: string;
  uri?: string;
  path?: string;
}): string | null {
  const candidates: string[] = [];
  for (const key of ['path', 'filePath', 'absPath', 'absolutePath', 'fsPath']) {
    const val = file[key];
    if (typeof val === 'string' && val) {
      candidates.push(val);
    }
  }
  for (const rawUri of [file.resourceUri, file.uri]) {
    if (typeof rawUri !== 'string' || !rawUri) continue;
    if (rawUri.startsWith('file://')) {
      try {
        candidates.push(fileURLToPath(rawUri));
      } catch {
        // Ignore malformed file URI
      }
    } else if (rawUri.includes('://')) {
      try {
        const parsed = new URL(rawUri);
        const queryPath = parsed.searchParams.get('path') || parsed.searchParams.get('uri');
        if (queryPath) {
          candidates.push(queryPath.startsWith('file://') ? fileURLToPath(queryPath) : queryPath);
        }
        const decodedPathname = decodeURIComponent(parsed.pathname);
        if (decodedPathname && decodedPathname.startsWith('/')) {
          candidates.push(decodedPathname);
        }
      } catch {
        // Ignore non-standard URI
      }
    } else if (path.isAbsolute(rawUri)) {
      candidates.push(rawUri);
    }
  }

  for (const cand of candidates) {
    try {
      const resolved = path.resolve(cand);
      if (
        path.extname(resolved).toLowerCase() === '.pdf' &&
        fs.existsSync(resolved) &&
        fs.statSync(resolved).isFile()
      ) {
        return resolved;
      }
    } catch {
      // Continue trying candidates
    }
  }
  return null;
}

function findRegisteredByFileName(fileName: string): RegisteredPdf | null {
  const target = path.basename(fileName || '').toLowerCase();
  if (!target) return null;

  let best: { reg: RegisteredPdf; mtimeMs: number } | null = null;
  for (const reg of Array.from(registeredPdfs.values()).reverse()) {
    if (reg.meta.fileName.toLowerCase() !== target) continue;
    try {
      if (!fs.existsSync(reg.absPath)) continue;
      const stat = fs.statSync(reg.absPath);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { reg, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Ignore unreadable file
    }
  }
  return best?.reg ?? null;
}

function findPdfOnDiskByName(rawFileName: string): string | null {
  const baseName = path.basename(rawFileName || '');
  if (!baseName || !baseName.toLowerCase().endsWith('.pdf')) return null;

  // 1. Check persisted registry first
  const fromRegistry = findRegisteredByFileName(baseName);
  if (fromRegistry) return fromRegistry.absPath;

  const matches: Array<{ absPath: string; mtimeMs: number }> = [];
  const seen = new Set<string>();

  const consider = (p: string) => {
    try {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) return;
      if (path.basename(resolved).toLowerCase() !== baseName.toLowerCase()) return;
      if (!fs.existsSync(resolved)) return;
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return;
      seen.add(resolved);
      matches.push({ absPath: resolved, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore inaccessible paths
    }
  };

  // 2. Fast macOS Spotlight query by exact filename
  if (process.platform === 'darwin') {
    try {
      const escaped = baseName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const out = execFileSync('mdfind', [`kMDItemFSName == "${escaped}"`], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) consider(trimmed);
      }
    } catch {
      // Spotlight unavailable or timed out; fall through to bounded directory check
    }
  }

  // 3. Direct check in common user folders + shallow scan of ~/git (depth <= 4)
  if (matches.length === 0) {
    const home = os.homedir();
    for (const dir of [
      path.join(home, 'Downloads'),
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
    ]) {
      consider(path.join(dir, baseName));
    }

    const walkRoots = [path.join(home, 'git')];
    const skipDirs = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.cache', '_alpha_cache']);
    let visited = 0;
    const maxVisited = 2500;

    const walk = (dir: string, depth: number) => {
      if (depth > 4 || visited >= maxVisited) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        visited++;
        if (visited >= maxVisited) return;
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === baseName.toLowerCase()) {
          consider(full);
        } else if (ent.isDirectory() && !ent.name.startsWith('.') && !skipDirs.has(ent.name)) {
          walk(full, depth + 1);
        }
      }
    };

    for (const root of walkRoots) {
      if (fs.existsSync(root)) walk(root, 0);
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0].absPath;
}

function registerPdfList(
  items: Array<{ path: string; label?: string; page?: number }>,
  defaultPage: number,
): PdfSlotMeta[] {
  const metas: PdfSlotMeta[] = [];

  for (let i = 0; i < Math.min(items.length, 5); i++) {
    const item = items[i];
    const meta = registerSingleDiskPdf(item.path, item.label, item.page ?? defaultPage ?? 1);
    metas.push(meta);
  }

  if (metas.length > 0) {
    saveRegistry();
  }
  return metas;
}

function readAppHtml(): string {
  const overridePath = process.env.PDF_VIEWER_APP_HTML;
  const htmlPath = overridePath || path.join(PLUGIN_ROOT, 'dist', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`PDF Viewer HTML bundle missing at ${htmlPath}. Run npm run build.`);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function startLocalRangeServer(): Promise<string | null> {
  return new Promise((resolve) => {
    const httpServer = http.createServer((req, res) => {
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Encoding, Content-Length, Content-Range',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store',
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, corsHeaders);
        res.end('Method Not Allowed');
        return;
      }

      let pathname = '';
      try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      } catch {
        res.writeHead(400, corsHeaders);
        res.end('Bad Request');
        return;
      }

      const match = /^\/pdf\/([a-f0-9]+)\/([a-f0-9]+)$/.exec(pathname);
      if (!match || !tokensEqual(match[1], STREAM_TOKEN)) {
        res.writeHead(403, corsHeaders);
        res.end('Forbidden');
        return;
      }

      const pdfId = match[2];
      const reg = registeredPdfs.get(pdfId);
      if (!reg || !fs.existsSync(reg.absPath)) {
        res.writeHead(404, corsHeaders);
        res.end('Not Found');
        return;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(reg.absPath);
        if (!stat.isFile()) {
          res.writeHead(404, corsHeaders);
          res.end('Not Found');
          return;
        }
      } catch {
        res.writeHead(404, corsHeaders);
        res.end('Not Found');
        return;
      }

      const totalSize = stat.size;
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (!rangeMatch) {
          res.writeHead(416, {
            ...corsHeaders,
            'Content-Range': `bytes */${totalSize}`,
          });
          res.end();
          return;
        }

        let start: number;
        let end: number;

        if (rangeMatch[1] === '' && rangeMatch[2] !== '') {
          const suffixLen = parseInt(rangeMatch[2], 10);
          if (Number.isNaN(suffixLen) || suffixLen <= 0) {
            res.writeHead(416, { ...corsHeaders, 'Content-Range': `bytes */${totalSize}` });
            res.end();
            return;
          }
          start = Math.max(0, totalSize - suffixLen);
          end = totalSize - 1;
        } else {
          start = parseInt(rangeMatch[1], 10);
          end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalSize - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
            res.writeHead(416, { ...corsHeaders, 'Content-Range': `bytes */${totalSize}` });
            res.end();
            return;
          }
          end = Math.min(end, totalSize - 1);
        }

        const chunkLen = end - start + 1;
        res.writeHead(206, {
          ...corsHeaders,
          'Content-Type': 'application/pdf',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Content-Length': String(chunkLen),
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(reg.absPath, { start, end });
        const cleanup = () => {
          if (!stream.destroyed) stream.destroy();
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500, corsHeaders);
          res.end();
        });
        stream.pipe(res);
        return;
      }

      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(reg.absPath);
      const cleanup = () => {
        if (!stream.destroyed) stream.destroy();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500, corsHeaders);
        res.end();
      });
      stream.pipe(res);
    });

    httpServer.on('error', (err) => {
      appendDebugLog('range_server_error', { message: err.message });
      resolve(null);
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        httpServer.unref();
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        resolve(null);
      }
    });
  });
}

const PdfFileInputSchema = z.object({
  path: z.string().describe('Absolute path to a .pdf file'),
  label: z.string().optional().describe('Optional short tab label (under ~28 chars recommended)'),
  page: z.number().int().min(1).optional().describe('Optional 1-based starting page for this PDF'),
});

const SharedViewerArgs = {
  path: z
    .string()
    .optional()
    .describe('Absolute path to a single .pdf file to view (convenience shorthand for files: [{ path }])'),
  files: z
    .array(PdfFileInputSchema)
    .max(5)
    .optional()
    .describe('Up to 5 PDF files to display with tabs for quick switching'),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Initial 1-based page number to open to (default 1)'),
  activeIndex: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe('0-based index of the active PDF tab when passing multiple files (default 0)'),
  title: z.string().optional().describe('Optional header title for the viewer'),
  viewMode: z
    .enum(['single', 'spread', 'scroll'])
    .optional()
    .describe('Page layout: "single" (one page at a time, default), "spread" (2-page book spread), or "scroll" (continuous vertical scroll)'),
  zoom: z
    .enum(['fit-page', 'fit-width', 'actual'])
    .optional()
    .describe('Initial zoom mode: "fit-page" (default), "fit-width", or "actual" (100%)'),
  height: z
    .number()
    .int()
    .min(320)
    .max(780)
    .optional()
    .describe('Inline frame height in pixels (320-780, default 640; ignored in side panel)'),
};

function normalizeFileArgs(args: {
  path?: string;
  files?: Array<{ path: string; label?: string; page?: number }>;
  page?: number;
}): Array<{ path: string; label?: string; page?: number }> {
  const result: Array<{ path: string; label?: string; page?: number }> = [];
  if (args.files && args.files.length > 0) {
    result.push(...args.files);
  }
  if (args.path) {
    const abs = path.resolve(args.path);
    const already = result.some((f) => path.resolve(f.path) === abs);
    if (!already) {
      result.unshift({ path: args.path, page: args.page });
    }
  }
  return result.slice(0, 5);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function buildSessionResult(
  layout: ViewerLayout,
  args: {
    path?: string;
    files?: Array<{ path: string; label?: string; page?: number }>;
    page?: number;
    activeIndex?: number;
    title?: string;
    viewMode?: ViewMode;
    zoom?: ZoomMode;
    height?: number;
  },
) {
  let effectiveFiles = normalizeFileArgs(args);
  let effectiveTitle = args.title;
  let effectiveActive = args.activeIndex ?? 0;
  let effectiveViewMode: ViewMode = args.viewMode ?? 'single';
  let effectiveZoom: ZoomMode = args.zoom ?? 'fit-page';
  let effectiveHeight = Math.min(780, Math.max(320, args.height ?? 640));

  if (effectiveFiles.length === 0) {
    const prev = loadLastSession();
    if (prev) {
      effectiveFiles = prev.files;
      effectiveTitle = effectiveTitle ?? prev.title;
      effectiveActive = args.activeIndex ?? prev.activeIndex;
      effectiveViewMode = args.viewMode ?? prev.viewMode;
      effectiveZoom = args.zoom ?? prev.zoomMode;
      effectiveHeight = args.height ?? prev.inlineHeight ?? 640;
    }
  } else {
    saveLastSession({
      title: effectiveTitle || 'PDF Viewer',
      activeIndex: effectiveActive,
      viewMode: effectiveViewMode,
      zoomMode: effectiveZoom,
      inlineHeight: effectiveHeight,
      files: effectiveFiles,
    });
  }

  const metas = registerPdfList(effectiveFiles, args.page ?? 1);
  const clampedActive = metas.length > 0 ? Math.min(Math.max(0, effectiveActive), metas.length - 1) : 0;

  const payload: PdfSessionPayload = {
    kind: 'session',
    sessionId: crypto.randomUUID(),
    layout,
    title: effectiveTitle || (metas.length === 1 ? metas[0].label : 'PDF Viewer'),
    activeIndex: clampedActive,
    viewMode: effectiveViewMode,
    zoomMode: effectiveZoom,
    inlineHeight: effectiveHeight,
    pdfs: metas,
  };

  const summary =
    metas.length === 0
      ? 'Opened PDF Viewer (no PDF loaded yet — drop a .pdf file into the viewer or pass a file path).'
      : `Displaying ${metas.length} PDF${metas.length === 1 ? '' : 's'} in ${layout === 'inline' ? 'Inline Viewer' : 'Side Panel'}: ${metas
          .map((m, i) => `[${i + 1}] ${m.fileName} (${formatBytes(m.sizeBytes)}, starting at p. ${m.initialPage})`)
          .join(', ')}.`;

  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

async function main() {
  streamOrigin = await startLocalRangeServer();
  loadRegistry();
  appendDebugLog('startup', {
    streamOrigin,
    dataDir: DATA_DIR,
    registeredCount: registeredPdfs.size,
  });

  const server = new McpServer(
    {
      name: 'pdf-viewer',
      version: '1.2.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  const resourceUiMeta: Record<string, unknown> = {
    prefersBorder: true,
    ...(streamOrigin
      ? {
          csp: {
            resourceDomains: [streamOrigin],
            connectDomains: [streamOrigin],
          },
        }
      : {}),
  };

  server.registerResource(
    'Inline PDF Viewer App',
    APP_URI,
    {
      description: 'Interactive PDF.js viewer with loopback HTTP range streaming, search, thumbnails, outline, zoom, and 2-page spread mode',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: resourceUiMeta,
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: readAppHtml(),
          _meta: {
            ui: resourceUiMeta,
          },
        },
      ],
    }),
  );

  // 1. Primary Inline Chat PDF Viewer (no aux_pane entrypoint -> renders directly inline in chat)
  server.registerTool(
    'view_pdf_inline',
    {
      title: 'Inline PDF Viewer',
      description:
        'Render 1 to 5 local PDF files inline right inside the chat conversation with full page navigation, zoom, search, text selection, outline, thumbnails, and 2-page book spread mode.',
      inputSchema: SharedViewerArgs,
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
      },
    },
    async (args) => {
      const normalized = normalizeFileArgs(args);
      if (normalized.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Provide either "path" (absolute path to a .pdf) or "files" (1-5 PDF entries) to view inline.',
            },
          ],
        };
      }
      try {
        return buildSessionResult('inline', args);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 2. Full-Height Side Panel PDF Viewer (aux_pane entrypoint)
  server.registerTool(
    'open_pdf_viewer',
    {
      title: 'PDF Viewer',
      description:
        'Open or update 1 to 5 local PDF files in the full-height PDF Viewer side panel. Calling with no arguments reopens the last viewed PDF or shows a drop zone.',
      inputSchema: SharedViewerArgs,
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [{ type: 'aux_pane', title: 'PDF Viewer' }],
        },
      },
    },
    async (args) => {
      try {
        return buildSessionResult('pane', args);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 3. Custom File Viewer entrypoint for .pdf files + instant inline-to-side-panel promotion
  server.registerTool(
    'view_pdf_file',
    {
      title: 'PDF Viewer',
      description: 'Host-invoked custom file viewer for .pdf files.',
      inputSchema: {
        file: z
          .object({
            name: z.string(),
            resourceUri: z.string().optional(),
            uri: z.string().optional(),
            path: z.string().optional(),
          })
          .passthrough()
          .optional(),
      },
      _meta: {
        ui: {
          resourceUri: APP_URI,
          visibility: ['app'],
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            {
              type: 'file',
              title: 'PDF Viewer',
              extensions: ['.pdf'],
            },
          ],
        },
      },
    },
    async ({ file }) => {
      appendDebugLog('view_pdf_file', { file });

      if (
        file &&
        pendingPromotedSession &&
        Date.now() - pendingPromotedSession.createdAt <= PROMOTED_SESSION_TTL_MS &&
        pendingPromotedSession.activeFileName.toLowerCase() === file.name.toLowerCase()
      ) {
        const promoted = pendingPromotedSession.payload;
        pendingPromotedSession = null;
        return {
          content: [{ type: 'text' as const, text: `Opened promoted PDF Viewer session for ${file.name}.` }],
          structuredContent: promoted as unknown as Record<string, unknown>,
        };
      }

      if (!file) {
        return buildSessionResult('pane', {});
      }

      // 1. Direct local disk path from host file metadata/URI
      const directLocalPath = tryResolveLocalPdfPath(file);
      if (directLocalPath) {
        appendDebugLog('view_pdf_file_resolved_direct', { directLocalPath });
        return buildSessionResult('pane', { path: directLocalPath });
      }

      // 2. Match against persistent registry (survives restarts; bypasses 10 MiB antigravity-file:// cap)
      const reg = findRegisteredByFileName(file.name);
      if (reg && fs.existsSync(reg.absPath)) {
        const meta = registerSingleDiskPdf(reg.absPath, reg.meta.label, 1);
        saveRegistry();
        appendDebugLog('view_pdf_file_resolved_registry', { absPath: reg.absPath, sizeBytes: meta.sizeBytes });
        const sessionPayload: PdfSessionPayload = {
          kind: 'session',
          sessionId: crypto.randomUUID(),
          layout: 'pane',
          title: meta.label,
          activeIndex: 0,
          viewMode: 'single',
          zoomMode: 'fit-page',
          inlineHeight: 640,
          pdfs: [meta],
        };
        return {
          content: [{ type: 'text' as const, text: `Opened ${file.name} in PDF Viewer.` }],
          structuredContent: sessionPayload as unknown as Record<string, unknown>,
        };
      }

      // 3. Fall back to host file_viewer (app reads via resources/read, and if >10 MiB fails,
      //    automatically calls resolve_pdf_by_name to locate on disk and stream via loopback HTTP!)
      const effectiveUri = file.resourceUri || file.uri || '';
      const payload: PdfFileViewerPayload = {
        kind: 'file_viewer',
        layout: 'pane',
        file: {
          name: file.name,
          resourceUri: effectiveUri,
        },
      };
      return {
        content: [{ type: 'text' as const, text: `Opened ${file.name} in PDF Viewer.` }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // 4. App-only live source resolver (refreshes disk mtime/size + live loopback streamUrl after restarts)
  server.registerTool(
    'get_pdf_source',
    {
      title: 'Resolve PDF Source',
      description: 'App-only tool that refreshes disk metadata and returns the live local range-stream URL for a registered PDF.',
      inputSchema: {
        pdfId: z.string(),
        fileName: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ pdfId, fileName }) => {
      let reg = registeredPdfs.get(pdfId);
      if ((!reg || !fs.existsSync(reg.absPath)) && fileName) {
        const byName = findRegisteredByFileName(fileName);
        if (byName) {
          reg = byName;
        } else {
          const onDisk = findPdfOnDiskByName(fileName);
          if (onDisk) {
            const meta = registerSingleDiskPdf(onDisk);
            saveRegistry();
            reg = registeredPdfs.get(meta.id);
          }
        }
      }

      if (!reg) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown pdfId: ${pdfId}` }],
        };
      }
      if (!fs.existsSync(reg.absPath)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `PDF file no longer exists on disk: ${reg.absPath}` }],
        };
      }

      const stat = fs.statSync(reg.absPath);
      reg.meta.sizeBytes = stat.size;
      reg.meta.mtimeMs = stat.mtimeMs;
      reg.meta.streamUrl = buildStreamUrl(reg.id, stat.mtimeMs);

      const resp: ResolvePdfSourceResponse = {
        pdfId: reg.id,
        label: reg.meta.label,
        fileName: reg.meta.fileName,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        streamUrl: reg.meta.streamUrl,
      };
      return {
        content: [{ type: 'text' as const, text: `Resolved ${reg.meta.fileName} (${formatBytes(stat.size)})` }],
        structuredContent: resp as unknown as Record<string, unknown>,
      };
    },
  );

  // 5. App-only cold-click disk resolver for >10 MiB PDFs clicked via opaque antigravity-file:// URIs
  server.registerTool(
    'resolve_pdf_by_name',
    {
      title: 'Resolve Clicked PDF by Name',
      description: 'App-only fallback that locates a clicked .pdf file on local disk when host resources/read exceeds size limits.',
      inputSchema: {
        fileName: z.string(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ fileName }) => {
      const foundPath = findPdfOnDiskByName(fileName);
      appendDebugLog('resolve_pdf_by_name', { fileName, foundPath });
      if (!foundPath) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Could not locate "${fileName}" on local disk.` }],
        };
      }

      const meta = registerSingleDiskPdf(foundPath);
      saveRegistry();
      const resp: ResolvePdfSourceResponse = {
        pdfId: meta.id,
        label: meta.label,
        fileName: meta.fileName,
        sizeBytes: meta.sizeBytes,
        mtimeMs: meta.mtimeMs,
        streamUrl: meta.streamUrl,
      };
      return {
        content: [{ type: 'text' as const, text: `Located ${meta.fileName} (${formatBytes(meta.sizeBytes)})` }],
        structuredContent: resp as unknown as Record<string, unknown>,
      };
    },
  );

  // 6. App-only helper to promote current inline state to side panel
  server.registerTool(
    'promote_pdf_to_pane',
    {
      title: 'Promote Inline PDF to Side Panel',
      description: 'App-only tool that registers current inline viewer state for instant side-panel opening.',
      inputSchema: {
        pdfIds: z.array(z.string()).min(1).max(5),
        activeIndex: z.number().int().min(0).max(4).default(0),
        currentPage: z.number().int().min(1).default(1),
        title: z.string().optional(),
        viewMode: z.enum(['single', 'spread', 'scroll']).default('single'),
        zoomMode: z.enum(['fit-page', 'fit-width', 'actual']).default('fit-page'),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ pdfIds, activeIndex, currentPage, title, viewMode, zoomMode }) => {
      const regs: RegisteredPdf[] = [];
      for (const id of pdfIds) {
        const reg = registeredPdfs.get(id);
        if (reg && fs.existsSync(reg.absPath)) regs.push(reg);
      }
      if (regs.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'No registered PDFs found for promotion.' }],
        };
      }

      const clampedActive = Math.min(Math.max(0, activeIndex), regs.length - 1);
      const activeReg = regs[clampedActive];
      const fileUri = pathToFileURL(activeReg.absPath).href;

      const promotedMetas: PdfSlotMeta[] = regs.map((r, idx) => {
        const stat = fs.statSync(r.absPath);
        return {
          ...r.meta,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          streamUrl: buildStreamUrl(r.id, stat.mtimeMs),
          initialPage: idx === clampedActive ? currentPage : r.meta.initialPage,
        };
      });

      const promotedPayload: PdfSessionPayload = {
        kind: 'session',
        sessionId: crypto.randomUUID(),
        layout: 'pane',
        title: title || (regs.length === 1 ? activeReg.meta.label : 'PDF Viewer'),
        activeIndex: clampedActive,
        viewMode,
        zoomMode,
        inlineHeight: 640,
        pdfs: promotedMetas,
      };

      pendingPromotedSession = {
        createdAt: Date.now(),
        activeFileName: activeReg.meta.fileName,
        payload: promotedPayload,
      };

      const resp: PromotePdfResponse = {
        fileUri,
        fileName: activeReg.meta.fileName,
      };
      return {
        content: [{ type: 'text' as const, text: `Prepared side panel view for ${activeReg.meta.fileName}` }],
        structuredContent: resp as unknown as Record<string, unknown>,
      };
    },
  );

  // 7. App-only chunked / byte-range PDF binary streamer (fallback when loopback HTTP is unavailable)
  server.registerTool(
    'load_pdf_chunk',
    {
      title: 'Load PDF Chunk',
      description:
        'App-only tool that streams a registered PDF file in <=512 KiB base64 chunks by chunkIndex or explicit byte offset/length.',
      inputSchema: {
        pdfId: z.string().describe('Registered PDF ID from the session payload'),
        chunkIndex: z.number().int().min(0).default(0),
        offset: z.number().int().min(0).optional().describe('Optional explicit byte offset for range streaming'),
        length: z
          .number()
          .int()
          .min(1)
          .max(CHUNK_SIZE_BYTES)
          .optional()
          .describe('Optional explicit byte length (max 512 KiB) for range streaming'),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ pdfId, chunkIndex, offset, length }) => {
      const reg = registeredPdfs.get(pdfId);
      if (!reg) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown pdfId: ${pdfId}` }],
        };
      }
      if (!fs.existsSync(reg.absPath)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `PDF file no longer exists on disk: ${reg.absPath}` }],
        };
      }

      const stat = fs.statSync(reg.absPath);
      const totalBytes = stat.size;
      const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE_BYTES));

      let start: number;
      let sliceLen: number;
      let clampedIdx: number;

      if (typeof offset === 'number') {
        start = Math.min(Math.max(0, offset), totalBytes);
        const reqLen = Math.min(CHUNK_SIZE_BYTES, Math.max(1, length ?? CHUNK_SIZE_BYTES));
        sliceLen = Math.max(0, Math.min(reqLen, totalBytes - start));
        clampedIdx = Math.floor(start / CHUNK_SIZE_BYTES);
      } else {
        clampedIdx = Math.min(Math.max(0, chunkIndex), totalChunks - 1);
        start = clampedIdx * CHUNK_SIZE_BYTES;
        sliceLen = Math.max(0, Math.min(CHUNK_SIZE_BYTES, totalBytes - start));
      }

      const buf = Buffer.allocUnsafe(sliceLen);
      if (sliceLen > 0) {
        const fd = fs.openSync(reg.absPath, 'r');
        try {
          fs.readSync(fd, buf, 0, sliceLen, start);
        } finally {
          fs.closeSync(fd);
        }
      }

      reg.meta.sizeBytes = totalBytes;
      reg.meta.mtimeMs = stat.mtimeMs;

      const resp: LoadPdfChunkResponse = {
        pdfId,
        fileName: reg.meta.fileName,
        totalBytes,
        mtimeMs: stat.mtimeMs,
        offset: start,
        length: sliceLen,
        chunkIndex: clampedIdx,
        totalChunks,
        dataBase64: buf.toString('base64'),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: `Bytes ${start}-${start + sliceLen} of ${totalBytes} (${sliceLen} bytes)`,
          },
        ],
        structuredContent: resp as unknown as Record<string, unknown>,
      };
    },
  );

  // 8. App-only fast local save for registered PDFs (copies directly on disk to ~/Downloads without clobbering)
  server.registerTool(
    'save_pdf_locally',
    {
      title: 'Save PDF Locally',
      description: 'App-only tool that saves a local copy of a registered PDF into ~/Downloads without overwriting existing files.',
      inputSchema: {
        pdfId: z.string().describe('Registered PDF ID from the session payload'),
        fileName: z.string().optional().describe('Optional preferred filename'),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ pdfId, fileName }) => {
      const reg = registeredPdfs.get(pdfId);
      if (!reg) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown pdfId: ${pdfId}` }],
        };
      }
      if (!fs.existsSync(reg.absPath)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `PDF file not found on disk: ${reg.absPath}` }],
        };
      }

      try {
        const targetPath = pickNonClobberingDownloadsPath(fileName || reg.meta.fileName);
        fs.copyFileSync(reg.absPath, targetPath);
        const stat = fs.statSync(targetPath);
        const resp: SavePdfResponse = {
          savedPath: targetPath,
          fileName: path.basename(targetPath),
          sizeBytes: stat.size,
        };
        return {
          content: [{ type: 'text' as const, text: `Saved PDF copy to ${targetPath}` }],
          structuredContent: resp as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Save failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // 9. App-only chunked local saver for file_viewer or dropped PDFs loaded in the browser
  server.registerTool(
    'save_pdf_chunk',
    {
      title: 'Save PDF Chunk Locally',
      description: 'App-only tool that receives base64 chunks of an in-memory PDF and writes a copy to ~/Downloads.',
      inputSchema: {
        uploadId: z.string(),
        fileName: z.string(),
        chunkIndex: z.number().int().min(0),
        totalChunks: z.number().int().min(1),
        dataBase64: z.string(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ uploadId, fileName, chunkIndex, totalChunks, dataBase64 }) => {
      try {
        let chunks = pendingSaveUploads.get(uploadId);
        if (!chunks || chunkIndex === 0) {
          chunks = new Array<Buffer>(totalChunks);
          pendingSaveUploads.set(uploadId, chunks);
        }
        chunks[chunkIndex] = Buffer.from(dataBase64, 'base64');

        if (chunkIndex < totalChunks - 1) {
          return {
            content: [{ type: 'text' as const, text: `Received chunk ${chunkIndex + 1}/${totalChunks}` }],
            structuredContent: { received: chunkIndex + 1, totalChunks },
          };
        }

        pendingSaveUploads.delete(uploadId);
        const fullBuf = Buffer.concat(chunks.filter(Boolean));
        const targetPath = pickNonClobberingDownloadsPath(fileName);
        fs.writeFileSync(targetPath, fullBuf);

        const resp: SavePdfResponse = {
          savedPath: targetPath,
          fileName: path.basename(targetPath),
          sizeBytes: fullBuf.length,
        };
        return {
          content: [{ type: 'text' as const, text: `Saved PDF copy to ${targetPath}` }],
          structuredContent: resp as unknown as Record<string, unknown>,
        };
      } catch (err) {
        pendingSaveUploads.delete(uploadId);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Save failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('pdf-viewer MCP server fatal error:', err);
  process.exit(1);
});
