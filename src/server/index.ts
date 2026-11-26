import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
  SavePdfResponse,
  ViewMode,
  ViewerLayout,
  ZoomMode,
} from '../shared/types.js';

const APP_URI = 'ui://pdf-viewer/app.html';
// 512 KiB raw -> ~699 KiB base64 JSON, safely below Antigravity's 1 MiB MCP payload cap
const CHUNK_SIZE_BYTES = 524_288;
const PROMOTED_SESSION_TTL_MS = 30_000;

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

const registeredPdfs = new Map<string, RegisteredPdf>();
const pendingSaveUploads = new Map<string, Buffer[]>();
let pendingPromotedSession: PromotedSession | null = null;

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

function tryResolveLocalPdfPath(file: {
  name: string;
  resourceUri?: string;
  uri?: string;
  path?: string;
}): string | null {
  const candidates: string[] = [];
  if (typeof file.path === 'string' && file.path) {
    candidates.push(file.path);
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

function lastSessionPath(): string {
  return path.join(DATA_DIR, 'last_session.json');
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

function makePdfId(absPath: string): string {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

function registerPdfList(
  items: Array<{ path: string; label?: string; page?: number }>,
  defaultPage: number,
): PdfSlotMeta[] {
  const metas: PdfSlotMeta[] = [];

  for (let i = 0; i < Math.min(items.length, 5); i++) {
    const item = items[i];
    const absPath = path.resolve(item.path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`PDF file not found: ${absPath}`);
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.pdf') {
      throw new Error(`Unsupported file type "${ext}" for ${path.basename(absPath)}. Expected .pdf`);
    }

    const id = makePdfId(absPath);
    const fileName = path.basename(absPath);
    const label = (item.label && item.label.trim()) || fileName.replace(/\.pdf$/i, '');
    const initialPage = Math.max(1, Math.floor(item.page ?? defaultPage ?? 1));

    const meta: PdfSlotMeta = {
      id,
      label,
      fileName,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      initialPage,
    };

    registeredPdfs.set(id, { id, absPath, meta });
    metas.push(meta);
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

const server = new McpServer(
  {
    name: 'pdf-viewer',
    version: '1.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.registerResource(
  'Inline PDF Viewer App',
  APP_URI,
  {
    description: 'Interactive PDF.js viewer with search, thumbnails, outline, zoom, and 2-page spread mode',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: true,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: readAppHtml(),
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

    // 1. Try resolving a direct local disk path from the clicked file URI so even 300+ MB PDFs
    //    stream instantly via on-demand byte-range requests (bypassing host 10 MiB resource caps).
    const directLocalPath = tryResolveLocalPdfPath(file);
    if (directLocalPath) {
      return buildSessionResult('pane', { path: directLocalPath });
    }

    // 2. If the file is already registered on disk, stream via chunked/range load_pdf_chunk
    for (const reg of registeredPdfs.values()) {
      if (reg.meta.fileName.toLowerCase() === file.name.toLowerCase() && fs.existsSync(reg.absPath)) {
        const stat = fs.statSync(reg.absPath);
        const updatedMeta: PdfSlotMeta = {
          ...reg.meta,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        reg.meta = updatedMeta;
        const sessionPayload: PdfSessionPayload = {
          kind: 'session',
          sessionId: crypto.randomUUID(),
          layout: 'pane',
          title: updatedMeta.label,
          activeIndex: 0,
          viewMode: 'single',
          zoomMode: 'fit-page',
          inlineHeight: 640,
          pdfs: [updatedMeta],
        };
        return {
          content: [{ type: 'text' as const, text: `Opened ${file.name} in PDF Viewer.` }],
          structuredContent: sessionPayload as unknown as Record<string, unknown>,
        };
      }
    }

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

// 4. App-only helper to promote current inline state to side panel
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

    const promotedMetas: PdfSlotMeta[] = regs.map((r, idx) => ({
      ...r.meta,
      initialPage: idx === clampedActive ? currentPage : r.meta.initialPage,
    }));

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

// 5. App-only chunked / byte-range PDF binary streamer (reads slices via fd offset, low memory footprint)
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

    // Keep cached metadata fresh
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

// 6. App-only fast local save for registered PDFs (copies directly on disk to ~/Downloads without clobbering)
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

// 7. App-only chunked local saver for file_viewer or dropped PDFs loaded in the browser
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('pdf-viewer MCP server fatal error:', err);
  process.exit(1);
});
