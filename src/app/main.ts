import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import * as pdfjsLib from 'pdfjs-dist';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
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
  ViewerPayload,
  ZoomMode,
} from '../shared/types.js';

// Wire PDF.js main-thread fake worker so it runs cleanly under strict default-src 'none' CSP
// without spawning blob: Workers or fetching external scripts.
(globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy;
type PDFPageProxy = pdfjsLib.PDFPageProxy;
type RenderTask = pdfjsLib.RenderTask;

interface SearchMatch {
  page: number;
  matchIndexInPage: number;
}

interface ViewerState {
  layout: 'inline' | 'pane';
  title: string;
  pdfs: PdfSlotMeta[];
  activeIndex: number;
  localFileName: string | null;
  currentRawBytes: Uint8Array | null;
  pdfDoc: PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  viewMode: ViewMode;
  zoomSetting: ZoomMode | number;
  computedScale: number;
  rotation: number;
  sidebarOpen: boolean;
  sidebarTab: 'thumbs' | 'outline';
  searchOpen: boolean;
  searchQuery: string;
  searchMatches: SearchMatch[];
  activeMatchIdx: number;
  loadToken: number;
  renderToken: number;
}

const state: ViewerState = {
  layout: 'inline',
  title: 'PDF Viewer',
  pdfs: [],
  activeIndex: 0,
  localFileName: null,
  currentRawBytes: null,
  pdfDoc: null,
  numPages: 0,
  currentPage: 1,
  viewMode: 'single',
  zoomSetting: 'fit-page',
  computedScale: 1,
  rotation: 0,
  sidebarOpen: false,
  sidebarTab: 'thumbs',
  searchOpen: false,
  searchQuery: '',
  searchMatches: [],
  activeMatchIdx: -1,
  loadToken: 0,
  renderToken: 0,
};

// Cache fetched raw PDF bytes per pdfId+mtimeMs so tab switching is instant
const bytesCache = new Map<string, Uint8Array>();
const pageTextCache = new Map<number, string>();
const activeRenderTasks = new Map<number, RenderTask>();
let scrollObserver: IntersectionObserver | null = null;
let thumbObserver: IntersectionObserver | null = null;
let renderedScrollPages = new Set<number>();
let mcpConnected = false;

// DOM references
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const btnSidebar = $<HTMLButtonElement>('btn-sidebar');
const docTitleEl = $<HTMLSpanElement>('doc-title');
const docMetaEl = $<HTMLSpanElement>('doc-meta');
const btnPrev = $<HTMLButtonElement>('btn-prev');
const btnNext = $<HTMLButtonElement>('btn-next');
const pageInput = $<HTMLInputElement>('page-input');
const pageCountEl = $<HTMLSpanElement>('page-count');
const modeSingleBtn = $<HTMLButtonElement>('mode-single');
const modeSpreadBtn = $<HTMLButtonElement>('mode-spread');
const modeScrollBtn = $<HTMLButtonElement>('mode-scroll');
const btnZoomOut = $<HTMLButtonElement>('btn-zoom-out');
const btnZoomIn = $<HTMLButtonElement>('btn-zoom-in');
const zoomSelect = $<HTMLSelectElement>('zoom-select');
const btnRotate = $<HTMLButtonElement>('btn-rotate');
const btnSearch = $<HTMLButtonElement>('btn-search');
const btnSave = $<HTMLButtonElement>('btn-save');
const btnReload = $<HTMLButtonElement>('btn-reload');
const btnPopPane = $<HTMLButtonElement>('btn-pop-pane');
const tabBar = $<HTMLDivElement>('tab-bar');
const searchBar = $<HTMLDivElement>('search-bar');
const searchInput = $<HTMLInputElement>('search-input');
const searchStatus = $<HTMLSpanElement>('search-status');
const btnSearchPrev = $<HTMLButtonElement>('btn-search-prev');
const btnSearchNext = $<HTMLButtonElement>('btn-search-next');
const btnSearchClose = $<HTMLButtonElement>('btn-search-close');
const sidebarEl = $<HTMLElement>('sidebar');
const sideTabThumbs = $<HTMLButtonElement>('side-tab-thumbs');
const sideTabOutline = $<HTMLButtonElement>('side-tab-outline');
const thumbsList = $<HTMLDivElement>('thumbs-list');
const outlineList = $<HTMLDivElement>('outline-list');
const stageEl = $<HTMLElement>('stage');
const pagesContainer = $<HTMLDivElement>('pages-container');
const loadingOverlay = $<HTMLDivElement>('loading-overlay');
const loadingText = $<HTMLDivElement>('loading-text');
const loadingBar = $<HTMLDivElement>('loading-bar');
const loadingSub = $<HTMLDivElement>('loading-sub');
const errorOverlay = $<HTMLDivElement>('error-overlay');
const errorText = $<HTMLDivElement>('error-text');
const emptyOverlay = $<HTMLDivElement>('empty-overlay');
const dragOverlay = $<HTMLDivElement>('drag-overlay');
const filePicker = $<HTMLInputElement>('file-picker');
const saveToast = $<HTMLDivElement>('save-toast');
const saveToastMsg = $<HTMLSpanElement>('save-toast-msg');
const btnToastCopy = $<HTMLButtonElement>('btn-toast-copy');
const btnToastClose = $<HTMLButtonElement>('btn-toast-close');

let toastTimer: number | undefined;
let lastSavedPath: string | null = null;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function showSaveToast(message: string, options?: { savedPath?: string; isError?: boolean; durationMs?: number }): void {
  window.clearTimeout(toastTimer);
  saveToastMsg.textContent = message;
  saveToast.classList.toggle('is-error', Boolean(options?.isError));
  lastSavedPath = options?.savedPath ?? null;
  btnToastCopy.textContent = 'Copy Path';
  btnToastCopy.classList.toggle('hidden', !lastSavedPath);
  saveToast.classList.remove('hidden');

  const ms = options?.durationMs ?? 6000;
  if (ms > 0) {
    toastTimer = window.setTimeout(() => {
      saveToast.classList.add('hidden');
    }, ms);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function showOverlay(which: 'none' | 'loading' | 'error' | 'empty'): void {
  loadingOverlay.classList.toggle('hidden', which !== 'loading');
  errorOverlay.classList.toggle('hidden', which !== 'error');
  emptyOverlay.classList.toggle('hidden', which !== 'empty');
}

function setLoading(title: string, pct = 0, sub = ''): void {
  loadingText.textContent = title;
  loadingBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  loadingSub.textContent = sub;
  showOverlay('loading');
}

function showError(msg: string): void {
  errorText.textContent = msg;
  showOverlay('error');
}

function setControlsEnabled(enabled: boolean): void {
  pageInput.disabled = !enabled;
  btnZoomOut.disabled = !enabled;
  btnZoomIn.disabled = !enabled;
  zoomSelect.disabled = !enabled;
  btnRotate.disabled = !enabled;
  btnSearch.disabled = !enabled;
  btnSave.disabled = !enabled;
  if (!enabled) {
    btnPrev.disabled = true;
    btnNext.disabled = true;
  }
}

function updateNavControls(): void {
  const hasDoc = Boolean(state.pdfDoc && state.numPages > 0);
  setControlsEnabled(hasDoc);
  if (!hasDoc) {
    pageInput.value = '1';
    pageCountEl.textContent = '—';
    return;
  }

  pageInput.value = String(state.currentPage);
  pageCountEl.textContent = String(state.numPages);

  if (state.viewMode === 'spread') {
    const pages = getSpreadPages(state.currentPage, state.numPages);
    btnPrev.disabled = pages[0] <= 1;
    btnNext.disabled = pages[pages.length - 1] >= state.numPages;
  } else {
    btnPrev.disabled = state.currentPage <= 1;
    btnNext.disabled = state.currentPage >= state.numPages;
  }

  modeSingleBtn.classList.toggle('active', state.viewMode === 'single');
  modeSpreadBtn.classList.toggle('active', state.viewMode === 'spread');
  modeScrollBtn.classList.toggle('active', state.viewMode === 'scroll');

  syncZoomDropdown();
  highlightActiveThumbnails();
}

function syncZoomDropdown(): void {
  const key = typeof state.zoomSetting === 'string' ? state.zoomSetting : String(state.zoomSetting);
  // Remove any previous custom zoom option
  const existingCustom = zoomSelect.querySelector('option[data-custom="1"]');
  if (existingCustom) existingCustom.remove();

  const matching = Array.from(zoomSelect.options).find((opt) => opt.value === key);
  if (matching) {
    zoomSelect.value = key;
  } else if (typeof state.zoomSetting === 'number') {
    const opt = document.createElement('option');
    opt.value = key;
    opt.dataset.custom = '1';
    opt.textContent = `${Math.round(state.zoomSetting * 100)}%`;
    zoomSelect.appendChild(opt);
    zoomSelect.value = key;
  }
}

function getSpreadPages(page: number, total: number): number[] {
  if (total <= 1 || page <= 1) return [1];
  const left = page % 2 === 0 ? page : page - 1;
  const right = left + 1;
  return right <= total ? [left, right] : [left];
}

function cancelAllRenderTasks(): void {
  for (const task of activeRenderTasks.values()) {
    try {
      task.cancel();
    } catch {
      // Ignore already finished
    }
  }
  activeRenderTasks.clear();
}

function disconnectObservers(): void {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  renderedScrollPages.clear();
}

function computePageScale(page: PDFPageProxy, spreadPair: boolean): number {
  const unscaled = page.getViewport({ scale: 1, rotation: state.rotation });
  const stageRect = stageEl.getBoundingClientRect();
  const availW = Math.max(240, stageRect.width - 36);
  const availH = Math.max(200, stageRect.height - 36);

  if (typeof state.zoomSetting === 'number') {
    return Math.max(0.25, Math.min(4.0, state.zoomSetting));
  }
  if (state.zoomSetting === 'actual') {
    return 1.0;
  }
  if (state.zoomSetting === 'fit-page') {
    const targetW = spreadPair ? (availW - 12) / 2 : availW;
    return Math.max(0.25, Math.min(targetW / unscaled.width, availH / unscaled.height));
  }
  // Default: fit-width
  const targetW = spreadPair ? (availW - 12) / 2 : availW;
  return Math.max(0.25, Math.min(3.0, targetW / unscaled.width));
}

async function renderPageIntoWrapper(
  pageNum: number,
  wrapper: HTMLDivElement,
  scale: number,
  token: number,
): Promise<void> {
  if (!state.pdfDoc || token !== state.renderToken) return;

  const existing = activeRenderTasks.get(pageNum);
  if (existing) {
    try {
      existing.cancel();
    } catch {
      // ignore
    }
    activeRenderTasks.delete(pageNum);
  }

  const page = await state.pdfDoc.getPage(pageNum);
  if (token !== state.renderToken) return;

  const viewport = page.getViewport({ scale, rotation: state.rotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  wrapper.style.width = `${Math.floor(viewport.width)}px`;
  wrapper.style.height = `${Math.floor(viewport.height)}px`;
  wrapper.style.setProperty('--scale-factor', String(viewport.scale));
  wrapper.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  wrapper.appendChild(canvas);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
  const renderTask = page.render({
    canvasContext: ctx,
    viewport,
    transform,
  });
  activeRenderTasks.set(pageNum, renderTask);

  try {
    await renderTask.promise;
  } catch (err: unknown) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
    if (name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (activeRenderTasks.get(pageNum) === renderTask) {
      activeRenderTasks.delete(pageNum);
    }
  }

  if (token !== state.renderToken) return;

  // Render selectable TextLayer on top of canvas
  try {
    const textContent = await page.getTextContent();
    if (token !== state.renderToken) return;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    wrapper.appendChild(textLayerDiv);

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    if (token !== state.renderToken) return;
    applySearchHighlightsToPage(pageNum, textLayerDiv);
  } catch {
    // Non-fatal: canvas is still rendered cleanly
  }
}

async function renderCurrentView(preserveScroll = false): Promise<void> {
  if (!state.pdfDoc) return;
  const token = ++state.renderToken;
  cancelAllRenderTasks();
  disconnectObservers();

  const prevScrollTop = stageEl.scrollTop;
  pagesContainer.innerHTML = '';

  const refPageNum = Math.min(state.numPages, Math.max(1, state.currentPage));
  const refPage = await state.pdfDoc.getPage(refPageNum);
  if (token !== state.renderToken) return;

  if (state.viewMode === 'single') {
    const scale = computePageScale(refPage, false);
    state.computedScale = scale;
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = String(refPageNum);
    pagesContainer.appendChild(wrapper);
    await renderPageIntoWrapper(refPageNum, wrapper, scale, token);
    if (!preserveScroll) stageEl.scrollTop = 0;
  } else if (state.viewMode === 'spread') {
    const spreadPages = getSpreadPages(refPageNum, state.numPages);
    const isPair = spreadPages.length === 2;
    const scale = computePageScale(refPage, isPair);
    state.computedScale = scale;

    const row = document.createElement('div');
    row.className = 'spread-row';
    pagesContainer.appendChild(row);

    const wrappers: Array<{ num: number; el: HTMLDivElement }> = [];
    for (const pNum of spreadPages) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.page = String(pNum);
      row.appendChild(wrapper);
      wrappers.push({ num: pNum, el: wrapper });
    }

    await Promise.all(wrappers.map((w) => renderPageIntoWrapper(w.num, w.el, scale, token)));
    if (!preserveScroll) stageEl.scrollTop = 0;
  } else {
    // Continuous vertical scroll with IntersectionObserver lazy rendering
    const scale = computePageScale(refPage, false);
    state.computedScale = scale;
    const baseVp = refPage.getViewport({ scale, rotation: state.rotation });
    const estW = Math.floor(baseVp.width);
    const estH = Math.floor(baseVp.height);

    const frag = document.createDocumentFragment();
    for (let p = 1; p <= state.numPages; p++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.page = String(p);
      wrapper.style.width = `${estW}px`;
      wrapper.style.height = `${estH}px`;
      wrapper.innerHTML = `<div class="page-placeholder">Page ${p}</div>`;
      frag.appendChild(wrapper);
    }
    pagesContainer.appendChild(frag);

    scrollObserver = new IntersectionObserver(
      (entries) => {
        if (token !== state.renderToken) return;
        for (const entry of entries) {
          const el = entry.target as HTMLDivElement;
          const pNum = Number(el.dataset.page);
          if (entry.isIntersecting && !renderedScrollPages.has(pNum)) {
            renderedScrollPages.add(pNum);
            void renderPageIntoWrapper(pNum, el, scale, token);
          }
        }
        // Keep memory bounded on huge books (>20 rendered canvases)
        if (renderedScrollPages.size > 20) {
          for (const renderedP of Array.from(renderedScrollPages)) {
            if (Math.abs(renderedP - state.currentPage) > 10) {
              const el = pagesContainer.querySelector<HTMLDivElement>(`.page-wrapper[data-page="${renderedP}"]`);
              if (el) {
                el.innerHTML = `<div class="page-placeholder">Page ${renderedP}</div>`;
              }
              renderedScrollPages.delete(renderedP);
            }
          }
        }
      },
      { root: stageEl, rootMargin: '600px 0px' },
    );

    const wrappers = pagesContainer.querySelectorAll<HTMLDivElement>('.page-wrapper');
    wrappers.forEach((w) => scrollObserver?.observe(w));

    if (preserveScroll) {
      stageEl.scrollTop = prevScrollTop;
    } else if (state.currentPage > 1) {
      const target = pagesContainer.querySelector<HTMLDivElement>(`.page-wrapper[data-page="${state.currentPage}"]`);
      if (target) {
        target.scrollIntoView({ block: 'start' });
      }
    } else {
      stageEl.scrollTop = 0;
    }
  }

  updateNavControls();
}

function goToPage(pageNum: number): void {
  if (!state.pdfDoc || state.numPages === 0) return;
  const clamped = Math.min(state.numPages, Math.max(1, Math.floor(pageNum)));
  if (clamped === state.currentPage && state.viewMode !== 'scroll') {
    updateNavControls();
    return;
  }
  state.currentPage = clamped;
  if (state.viewMode === 'scroll') {
    const target = pagesContainer.querySelector<HTMLDivElement>(`.page-wrapper[data-page="${clamped}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    updateNavControls();
  } else {
    void renderCurrentView();
  }
}

function stepPage(delta: number): void {
  if (!state.pdfDoc) return;
  if (state.viewMode === 'spread') {
    const curSpread = getSpreadPages(state.currentPage, state.numPages);
    if (delta > 0) {
      const next = curSpread[curSpread.length - 1] + 1;
      if (next <= state.numPages) goToPage(next);
    } else {
      const prev = curSpread[0] - 1;
      if (prev >= 1) goToPage(prev);
    }
  } else {
    goToPage(state.currentPage + delta);
  }
}

// Thumbnails & Outline sidebar
function rebuildSidebar(): void {
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  thumbsList.innerHTML = '';
  outlineList.innerHTML = '';

  if (!state.pdfDoc) return;

  const doc = state.pdfDoc;
  const frag = document.createDocumentFragment();
  for (let p = 1; p <= state.numPages; p++) {
    const btn = document.createElement('button');
    btn.className = 'thumb-item';
    btn.dataset.page = String(p);
    btn.innerHTML = `<div class="thumb-canvas-wrap"></div><span class="thumb-label">${p}</span>`;
    btn.addEventListener('click', () => goToPage(p));
    frag.appendChild(btn);
  }
  thumbsList.appendChild(frag);
  highlightActiveThumbnails();

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = entry.target as HTMLElement;
        if (item.dataset.rendered === '1') continue;
        item.dataset.rendered = '1';
        const pNum = Number(item.dataset.page);
        void renderThumbnail(doc, pNum, item);
      }
    },
    { root: thumbsList, rootMargin: '250px 0px' },
  );

  thumbsList.querySelectorAll<HTMLElement>('.thumb-item').forEach((el) => thumbObserver?.observe(el));

  void buildOutline(doc);
}

async function renderThumbnail(doc: PDFDocumentProxy, pageNum: number, item: HTMLElement): Promise<void> {
  if (state.pdfDoc !== doc) return;
  try {
    const page = await doc.getPage(pageNum);
    if (state.pdfDoc !== doc) return;
    const baseVp = page.getViewport({ scale: 1 });
    const targetW = 136;
    const scale = targetW / baseVp.width;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;

    const wrap = item.querySelector<HTMLDivElement>('.thumb-canvas-wrap');
    if (!wrap) return;
    wrap.style.minHeight = `${Math.floor(vp.height)}px`;
    wrap.innerHTML = '';
    wrap.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
  } catch {
    // Ignore canceled/destroyed doc
  }
}

function highlightActiveThumbnails(): void {
  const activeSet = new Set(
    state.viewMode === 'spread' ? getSpreadPages(state.currentPage, state.numPages) : [state.currentPage],
  );
  thumbsList.querySelectorAll<HTMLElement>('.thumb-item').forEach((el) => {
    const p = Number(el.dataset.page);
    el.classList.toggle('active', activeSet.has(p));
  });
}

async function buildOutline(doc: PDFDocumentProxy): Promise<void> {
  try {
    const outline = await doc.getOutline();
    if (state.pdfDoc !== doc) return;
    if (!outline || outline.length === 0) {
      outlineList.innerHTML = '<div class="outline-empty">No table of contents in this PDF.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    const walk = (items: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>, depth: number) => {
      if (!items) return;
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = 'outline-item';
        btn.style.paddingLeft = `${8 + depth * 14}px`;
        btn.textContent = item.title || 'Untitled section';
        btn.title = item.title || '';
        btn.addEventListener('click', async () => {
          if (!item.dest || state.pdfDoc !== doc) return;
          try {
            const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
            if (Array.isArray(dest) && dest[0]) {
              const pageIdx = await doc.getPageIndex(dest[0]);
              goToPage(pageIdx + 1);
            }
          } catch {
            // Ignore unresolvable dest
          }
        });
        frag.appendChild(btn);
        if (item.items && item.items.length > 0) {
          walk(item.items, depth + 1);
        }
      }
    };
    walk(outline, 0);
    outlineList.innerHTML = '';
    outlineList.appendChild(frag);
  } catch {
    outlineList.innerHTML = '<div class="outline-empty">No table of contents available.</div>';
  }
}

// Search across all pages
async function runSearch(query: string): Promise<void> {
  state.searchQuery = query.trim();
  state.searchMatches = [];
  state.activeMatchIdx = -1;

  if (!state.pdfDoc || !state.searchQuery) {
    searchStatus.textContent = '';
    btnSearchPrev.disabled = true;
    btnSearchNext.disabled = true;
    refreshAllTextHighlights();
    return;
  }

  const doc = state.pdfDoc;
  const qLower = state.searchQuery.toLowerCase();
  searchStatus.textContent = 'Searching…';

  const matches: SearchMatch[] = [];
  for (let p = 1; p <= state.numPages; p++) {
    if (state.pdfDoc !== doc || state.searchQuery.toLowerCase() !== qLower) return;
    let text = pageTextCache.get(p);
    if (text === undefined) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
      pageTextCache.set(p, text);
    }
    const lower = text.toLowerCase();
    let idx = 0;
    let localCount = 0;
    while ((idx = lower.indexOf(qLower, idx)) !== -1) {
      matches.push({ page: p, matchIndexInPage: localCount++ });
      idx += qLower.length;
    }
  }

  if (state.pdfDoc !== doc || state.searchQuery.toLowerCase() !== qLower) return;
  state.searchMatches = matches;

  if (matches.length === 0) {
    searchStatus.textContent = '0 matches';
    btnSearchPrev.disabled = true;
    btnSearchNext.disabled = true;
    refreshAllTextHighlights();
    return;
  }

  // Pick first match on or after currentPage
  let firstIdx = matches.findIndex((m) => m.page >= state.currentPage);
  if (firstIdx < 0) firstIdx = 0;
  state.activeMatchIdx = firstIdx;
  btnSearchPrev.disabled = false;
  btnSearchNext.disabled = false;
  updateSearchUIAndJump();
}

function updateSearchUIAndJump(): void {
  const total = state.searchMatches.length;
  if (total === 0 || state.activeMatchIdx < 0) {
    searchStatus.textContent = state.searchQuery ? '0 matches' : '';
    refreshAllTextHighlights();
    return;
  }
  searchStatus.textContent = `${state.activeMatchIdx + 1} / ${total}`;
  const match = state.searchMatches[state.activeMatchIdx];
  if (match.page !== state.currentPage) {
    goToPage(match.page);
  } else {
    refreshAllTextHighlights();
  }
}

function stepSearch(delta: number): void {
  if (state.searchMatches.length === 0) return;
  const len = state.searchMatches.length;
  state.activeMatchIdx = (state.activeMatchIdx + delta + len) % len;
  updateSearchUIAndJump();
}

function refreshAllTextHighlights(): void {
  pagesContainer.querySelectorAll<HTMLDivElement>('.page-wrapper').forEach((w) => {
    const pNum = Number(w.dataset.page);
    const tl = w.querySelector<HTMLDivElement>('.textLayer');
    if (tl) applySearchHighlightsToPage(pNum, tl);
  });
}

function applySearchHighlightsToPage(pageNum: number, textLayerDiv: HTMLDivElement): void {
  // Remove previous highlight classes
  textLayerDiv.querySelectorAll<HTMLElement>('.pdf-search-hit').forEach((el) => {
    el.classList.remove('pdf-search-hit', 'current');
  });
  if (!state.searchQuery) return;
  const qLower = state.searchQuery.toLowerCase();
  const activeMatch = state.activeMatchIdx >= 0 ? state.searchMatches[state.activeMatchIdx] : null;
  let hitCount = 0;

  textLayerDiv.querySelectorAll<HTMLSpanElement>('span').forEach((span) => {
    const txt = span.textContent?.toLowerCase() ?? '';
    if (txt.includes(qLower)) {
      span.classList.add('pdf-search-hit');
      if (activeMatch && activeMatch.page === pageNum && hitCount === activeMatch.matchIndexInPage) {
        span.classList.add('current');
      }
      hitCount++;
    }
  });
}

// Loading PDF into PDF.js (either full Uint8Array or on-demand PDFDataRangeTransport for huge PDFs)
const RANGE_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MAX_RANGE_SLICE_BYTES = 524_288;

class McpPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private readonly pdfId: string;
  private aborted = false;
  private inFlight = 0;
  private readonly maxConcurrency = 3;
  private readonly queue: Array<{ begin: number; end: number }> = [];

  constructor(pdfId: string, totalBytes: number, initialData: Uint8Array | null) {
    super(totalBytes, initialData);
    this.pdfId = pdfId;
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.aborted) return;
    this.queue.push({ begin, end });
    this.drainQueue();
  }

  override abort(): void {
    this.aborted = true;
    this.queue.length = 0;
  }

  private drainQueue(): void {
    while (!this.aborted && this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight++;
      void this.runRangeJob(job.begin, job.end).finally(() => {
        this.inFlight--;
        this.drainQueue();
      });
    }
  }

  private async runRangeJob(begin: number, end: number): Promise<void> {
    if (this.aborted) return;
    const clampedEnd = Math.min(this.length, Math.max(begin, end));
    const totalLen = clampedEnd - begin;
    if (totalLen <= 0) {
      this.onDataRange(begin, new Uint8Array(0));
      return;
    }

    try {
      if (totalLen <= MAX_RANGE_SLICE_BYTES) {
        const res = await fetchPdfRange(this.pdfId, begin, totalLen);
        if (this.aborted) return;
        this.onDataRange(begin, base64ToUint8Array(res.dataBase64));
        return;
      }

      // Assemble multi-slice range and deliver once at exact `begin` so PDF.js rangeReader matches
      const combined = new Uint8Array(totalLen);
      let cursor = 0;
      while (cursor < totalLen && !this.aborted) {
        const reqLen = Math.min(MAX_RANGE_SLICE_BYTES, totalLen - cursor);
        const res = await fetchPdfRange(this.pdfId, begin + cursor, reqLen);
        if (this.aborted) return;
        const part = base64ToUint8Array(res.dataBase64);
        combined.set(part, cursor);
        cursor += part.byteLength;
        if (part.byteLength === 0) break;
      }
      if (!this.aborted) {
        this.onDataRange(begin, combined.subarray(0, cursor));
      }
    } catch {
      if (!this.aborted) {
        this.onDataRange(begin, null);
      }
    }
  }
}

async function openPdfSource(
  source:
    | { kind: 'bytes'; bytes: Uint8Array }
    | { kind: 'url'; url: string; totalBytes: number }
    | { kind: 'range'; transport: McpPdfRangeTransport },
  displayName: string,
  sizeBytes: number,
  initialPage = 1,
  options?: { rethrowOnFailure?: boolean; token?: number },
): Promise<void> {
  const token = options?.token ?? ++state.loadToken;
  const rethrowOnFailure = Boolean(options?.rethrowOnFailure);
  cancelAllRenderTasks();
  disconnectObservers();
  pageTextCache.clear();
  state.searchMatches = [];
  state.activeMatchIdx = -1;

  if (state.pdfDoc) {
    try {
      await state.pdfDoc.destroy();
    } catch {
      // ignore
    }
    state.pdfDoc = null;
  }

  docTitleEl.textContent = displayName;
  docTitleEl.title = displayName;
  docMetaEl.textContent = formatBytes(sizeBytes);
  setLoading(`Rendering ${displayName}…`, 80, formatBytes(sizeBytes));

  try {
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask;
    if (source.kind === 'bytes') {
      loadingTask = pdfjsLib.getDocument({
        data: source.bytes.slice(),
        isEvalSupported: false,
        useWorkerFetch: false,
        useSystemFonts: true,
      });
    } else if (source.kind === 'url') {
      const large = source.totalBytes > RANGE_STREAM_THRESHOLD_BYTES;
      loadingTask = pdfjsLib.getDocument({
        url: source.url,
        rangeChunkSize: 65_536,
        disableAutoFetch: large,
        disableStream: large,
        isEvalSupported: false,
        useWorkerFetch: false,
        useSystemFonts: true,
      });
    } else {
      loadingTask = pdfjsLib.getDocument({
        range: source.transport,
        rangeChunkSize: 65_536,
        disableAutoFetch: true,
        disableStream: true,
        isEvalSupported: false,
        useWorkerFetch: false,
        useSystemFonts: true,
      });
    }

    const doc = await loadingTask.promise;
    if (token !== state.loadToken) {
      void doc.destroy();
      return;
    }

    state.pdfDoc = doc;
    state.numPages = doc.numPages;
    state.currentPage = Math.min(doc.numPages, Math.max(1, initialPage));
    docMetaEl.textContent = `${doc.numPages} pg · ${formatBytes(sizeBytes)}`;

    showOverlay('none');
    rebuildSidebar();
    await renderCurrentView();
    if (state.searchOpen && state.searchQuery) {
      void runSearch(state.searchQuery);
    }
  } catch (err) {
    if (token !== state.loadToken) return;
    if (rethrowOnFailure) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
  }
}

async function openPdfBytes(bytes: Uint8Array, displayName: string, sizeBytes: number, initialPage = 1): Promise<void> {
  state.currentRawBytes = bytes;
  return openPdfSource({ kind: 'bytes', bytes }, displayName, sizeBytes, initialPage);
}

// MCP App bridge
const app = new App({ name: 'Inline PDF Viewer', version: '1.2.0' }, {});

async function resolveLivePdfSource(pdfId: string, fileName?: string): Promise<ResolvePdfSourceResponse | null> {
  try {
    const res = await app.callServerTool({
      name: 'get_pdf_source',
      arguments: { pdfId, ...(fileName ? { fileName } : {}) },
    });
    if (res.isError) return null;
    const structured = res.structuredContent as unknown as ResolvePdfSourceResponse | undefined;
    return structured && typeof structured.pdfId === 'string' ? structured : null;
  } catch {
    return null;
  }
}

async function resolvePdfByNameOnServer(fileName: string): Promise<ResolvePdfSourceResponse | null> {
  try {
    const res = await app.callServerTool({
      name: 'resolve_pdf_by_name',
      arguments: { fileName },
    });
    if (res.isError) return null;
    const structured = res.structuredContent as unknown as ResolvePdfSourceResponse | undefined;
    return structured && typeof structured.pdfId === 'string' ? structured : null;
  } catch {
    return null;
  }
}

async function fetchPdfRange(pdfId: string, offset: number, length: number): Promise<LoadPdfChunkResponse> {
  const res = await app.callServerTool({
    name: 'load_pdf_chunk',
    arguments: { pdfId, offset, length },
  });
  if (res.isError) {
    const errText =
      res.content
        ?.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join(' ')
        .trim() || 'Failed to load PDF byte range';
    throw new Error(errText);
  }
  const structured = res.structuredContent as unknown as LoadPdfChunkResponse | undefined;
  if (!structured || typeof structured.dataBase64 !== 'string') {
    throw new Error('Server returned invalid PDF range payload');
  }
  return structured;
}

async function loadRegisteredPdf(slot: PdfSlotMeta, forceReload = false): Promise<void> {
  const token = ++state.loadToken;

  btnReload.classList.toggle('hidden', !mcpConnected);
  btnPopPane.classList.toggle('hidden', state.layout !== 'inline' || !mcpConnected || state.pdfs.length === 0);

  docTitleEl.textContent = slot.label || slot.fileName;
  docTitleEl.title = slot.fileName;
  docMetaEl.textContent = formatBytes(slot.sizeBytes);
  setLoading(`Opening ${slot.fileName}…`, 15, formatBytes(slot.sizeBytes));

  // Refresh live metadata + current server loopback URL (handles restarts & rebuilt files on disk)
  if (mcpConnected) {
    const live = await resolveLivePdfSource(slot.id, slot.fileName);
    if (token !== state.loadToken) return;
    if (live) {
      slot.id = live.pdfId;
      slot.sizeBytes = live.sizeBytes;
      slot.mtimeMs = live.mtimeMs;
      slot.streamUrl = live.streamUrl;
      docMetaEl.textContent = formatBytes(slot.sizeBytes);
    }
  }

  const cacheKey = `${slot.id}:${slot.mtimeMs}`;
  if (!forceReload && bytesCache.has(cacheKey)) {
    const cached = bytesCache.get(cacheKey)!;
    state.currentRawBytes = cached;
    await openPdfSource({ kind: 'bytes', bytes: cached }, slot.label || slot.fileName, cached.byteLength, slot.initialPage, {
      token,
    });
    return;
  }

  // Primary fast path: native PDF.js HTTP/1.1 Range streaming from local loopback server (<1s even for 500+ MB PDFs!)
  if (slot.streamUrl) {
    try {
      state.currentRawBytes = null;
      setLoading(`Streaming ${slot.fileName}…`, 50, formatBytes(slot.sizeBytes));
      const urlWithBuster = forceReload ? `${slot.streamUrl}&r=${Date.now()}` : slot.streamUrl;
      await openPdfSource(
        { kind: 'url', url: urlWithBuster, totalBytes: slot.sizeBytes },
        slot.label || slot.fileName,
        slot.sizeBytes,
        slot.initialPage,
        { rethrowOnFailure: true, token },
      );
      return;
    } catch {
      if (token !== state.loadToken) return;
      // Fall through cleanly to MCP chunk/range transport if loopback HTTP is blocked
    }
  }

  try {
    // Fallback path: probe first 64 KiB over MCP tool calls
    const first = await fetchPdfRange(slot.id, 0, 65_536);
    if (token !== state.loadToken) return;

    const totalBytes = first.totalBytes;
    const firstBytes = base64ToUint8Array(first.dataBase64);
    slot.sizeBytes = totalBytes;
    slot.mtimeMs = first.mtimeMs;

    // Large PDFs (> 4 MB): on-demand MCP byte-range streaming
    if (totalBytes > RANGE_STREAM_THRESHOLD_BYTES) {
      state.currentRawBytes = null;
      setLoading(`Streaming ${slot.fileName}…`, 60, `${formatBytes(totalBytes)} (on-demand)`);
      const transport = new McpPdfRangeTransport(slot.id, totalBytes, firstBytes);
      await openPdfSource({ kind: 'range', transport }, slot.label || slot.fileName, totalBytes, slot.initialPage, {
        token,
      });
      return;
    }

    // Small/medium PDFs (<= 4 MB): fetch remaining bytes upfront and cache for instant search & tab switching
    if (firstBytes.byteLength >= totalBytes) {
      bytesCache.set(`${slot.id}:${first.mtimeMs}`, firstBytes);
      state.currentRawBytes = firstBytes;
      await openPdfSource(
        { kind: 'bytes', bytes: firstBytes },
        slot.label || slot.fileName,
        firstBytes.byteLength,
        slot.initialPage,
        { token },
      );
      return;
    }

    const totalChunks = Math.ceil((totalBytes - firstBytes.byteLength) / MAX_RANGE_SLICE_BYTES);
    const parts = new Array<Uint8Array>(totalChunks + 1);
    parts[0] = firstBytes;

    let loadedBytes = firstBytes.byteLength;
    const concurrency = 3;
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < totalChunks) {
        const idx = nextIdx++;
        const offset = firstBytes.byteLength + idx * MAX_RANGE_SLICE_BYTES;
        const len = Math.min(MAX_RANGE_SLICE_BYTES, totalBytes - offset);
        const chunk = await fetchPdfRange(slot.id, offset, len);
        if (token !== state.loadToken) return;
        const bytes = base64ToUint8Array(chunk.dataBase64);
        parts[idx + 1] = bytes;
        loadedBytes += bytes.byteLength;
        setLoading(
          `Loading ${slot.fileName}…`,
          Math.round((loadedBytes / totalBytes) * 88),
          `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`,
        );
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, totalChunks) }, worker));
    if (token !== state.loadToken) return;

    const full = new Uint8Array(totalBytes);
    let writeOffset = 0;
    for (const part of parts) {
      if (!part) continue;
      full.set(part, writeOffset);
      writeOffset += part.byteLength;
    }

    bytesCache.set(`${slot.id}:${first.mtimeMs}`, full);
    state.currentRawBytes = full;
    await openPdfSource({ kind: 'bytes', bytes: full }, slot.label || slot.fileName, full.byteLength, slot.initialPage, {
      token,
    });
  } catch (err) {
    if (token !== state.loadToken) return;
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
  }
}

function renderTabs(): void {
  if (state.pdfs.length <= 1) {
    tabBar.classList.add('hidden');
    tabBar.innerHTML = '';
    return;
  }
  tabBar.classList.remove('hidden');
  tabBar.innerHTML = '';
  state.pdfs.forEach((pdf, idx) => {
    const btn = document.createElement('button');
    btn.className = `pdf-tab${idx === state.activeIndex ? ' active' : ''}`;
    btn.role = 'tab';
    btn.title = `${pdf.fileName} (${formatBytes(pdf.sizeBytes)})`;
    btn.innerHTML = `<span class="pdf-tab-label">${idx + 1}. ${escapeHtml(pdf.label)}</span>`;
    btn.addEventListener('click', () => {
      if (idx === state.activeIndex) return;
      // Remember current page on previous tab
      if (state.pdfs[state.activeIndex]) {
        state.pdfs[state.activeIndex].initialPage = state.currentPage;
      }
      state.activeIndex = idx;
      renderTabs();
      void loadRegisteredPdf(state.pdfs[idx]);
    });
    tabBar.appendChild(btn);
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applySessionPayload(payload: PdfSessionPayload): void {
  state.layout = payload.layout || 'inline';
  document.body.dataset.layout = state.layout;
  if (state.layout === 'inline') {
    const h = Math.min(780, Math.max(320, payload.inlineHeight || 640));
    document.body.style.setProperty('--inline-height', `${h}px`);
  }

  state.title = payload.title || 'PDF Viewer';
  state.pdfs = payload.pdfs || [];
  state.activeIndex = Math.min(Math.max(0, payload.activeIndex ?? 0), Math.max(0, state.pdfs.length - 1));
  state.viewMode = payload.viewMode || 'single';
  state.zoomSetting = payload.zoomMode || 'fit-page';
  state.rotation = 0;
  state.localFileName = null;

  renderTabs();

  if (state.pdfs.length === 0) {
    docTitleEl.textContent = state.title;
    docMetaEl.textContent = '';
    setControlsEnabled(false);
    btnReload.classList.add('hidden');
    btnPopPane.classList.add('hidden');
    showOverlay('empty');
    return;
  }

  void loadRegisteredPdf(state.pdfs[state.activeIndex]);
}

async function applyFileViewerPayload(payload: PdfFileViewerPayload): Promise<void> {
  state.layout = 'pane';
  document.body.dataset.layout = 'pane';
  state.pdfs = [];
  state.activeIndex = 0;
  state.viewMode = 'single';
  state.zoomSetting = 'fit-page';
  state.rotation = 0;
  state.localFileName = payload.file.name;
  renderTabs();
  btnReload.classList.add('hidden');
  btnPopPane.classList.add('hidden');

  setLoading(`Reading ${payload.file.name}…`, 25);
  try {
    if (!payload.file.resourceUri) {
      throw new Error('Missing resource URI from host');
    }
    const res = await app.request(
      {
        method: 'resources/read',
        params: { uri: payload.file.resourceUri },
      },
      z
        .object({
          contents: z.array(
            z
              .object({
                blob: z.string().optional(),
                text: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    );
    const first = res.contents?.[0];
    if (!first?.blob) {
      throw new Error(`Host did not return binary PDF content for ${payload.file.name}`);
    }
    const bytes = base64ToUint8Array(first.blob);
    await openPdfBytes(bytes, payload.file.name, bytes.byteLength, 1);
  } catch (readErr) {
    // Fallback for >10 MiB PDFs clicked cold via opaque antigravity-file:// URIs:
    // ask our local MCP server to locate the PDF on disk and stream it via loopback HTTP!
    if (mcpConnected && payload.file.name) {
      setLoading(`Locating ${payload.file.name} on disk…`, 35);
      const resolved = await resolvePdfByNameOnServer(payload.file.name);
      if (resolved) {
        const slot: PdfSlotMeta = {
          id: resolved.pdfId,
          label: resolved.label,
          fileName: resolved.fileName,
          sizeBytes: resolved.sizeBytes,
          mtimeMs: resolved.mtimeMs,
          initialPage: 1,
          streamUrl: resolved.streamUrl,
        };
        state.pdfs = [slot];
        state.activeIndex = 0;
        state.localFileName = null;
        await loadRegisteredPdf(slot);
        return;
      }
    }
    showError(readErr instanceof Error ? readErr.message : String(readErr));
  }
}

async function savePdfLocally(): Promise<void> {
  if (!state.pdfDoc) return;
  const activeSlot = state.pdfs[state.activeIndex];
  const fileName = activeSlot?.fileName || state.localFileName || 'document.pdf';

  btnSave.disabled = true;
  showSaveToast(`Saving ${fileName}…`, { durationMs: 0 });

  try {
    // 1. Registered server PDF: instant server-side disk copy to ~/Downloads (handles 300+ MB effortlessly)
    if (mcpConnected && activeSlot) {
      const res = await app.callServerTool({
        name: 'save_pdf_locally',
        arguments: { pdfId: activeSlot.id, fileName: activeSlot.fileName },
      });
      if (res.isError) {
        const errText =
          res.content
            ?.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
            .join(' ')
            .trim() || 'Failed to save PDF';
        throw new Error(errText);
      }
      const saved = res.structuredContent as unknown as SavePdfResponse | undefined;
      if (!saved?.savedPath) {
        throw new Error('Server did not return saved file path');
      }
      const shortPath = saved.savedPath.replace(/^\/Users\/[^/]+/, '~');
      showSaveToast(`Saved to ${shortPath} (${formatBytes(saved.sizeBytes)})`, {
        savedPath: saved.savedPath,
      });
      return;
    }

    // 2. In-memory PDF (file_viewer or drag-and-drop)
    const rawBytes = state.currentRawBytes ?? (await state.pdfDoc.getData());
    if (mcpConnected) {
      const uploadId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const totalChunks = Math.max(1, Math.ceil(rawBytes.byteLength / MAX_RANGE_SLICE_BYTES));
      let saved: SavePdfResponse | undefined;
      for (let i = 0; i < totalChunks; i++) {
        const start = i * MAX_RANGE_SLICE_BYTES;
        const slice = rawBytes.subarray(start, Math.min(start + MAX_RANGE_SLICE_BYTES, rawBytes.byteLength));
        const res = await app.callServerTool({
          name: 'save_pdf_chunk',
          arguments: {
            uploadId,
            fileName,
            chunkIndex: i,
            totalChunks,
            dataBase64: uint8ArrayToBase64(slice),
          },
        });
        if (res.isError) {
          const errText =
            res.content
              ?.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
              .join(' ')
              .trim() || 'Failed to save PDF chunk';
          throw new Error(errText);
        }
        if (i === totalChunks - 1) {
          saved = res.structuredContent as unknown as SavePdfResponse | undefined;
        }
      }
      if (!saved?.savedPath) {
        throw new Error('Server did not confirm saved file path');
      }
      const shortPath = saved.savedPath.replace(/^\/Users\/[^/]+/, '~');
      showSaveToast(`Saved to ${shortPath} (${formatBytes(saved.sizeBytes)})`, {
        savedPath: saved.savedPath,
      });
      return;
    }

    // 3. Standalone browser fallback
    const blobBytes = new Uint8Array(rawBytes.byteLength);
    blobBytes.set(rawBytes);
    const blob = new Blob([blobBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showSaveToast(`Downloaded ${fileName} (${formatBytes(rawBytes.byteLength)})`);
  } catch (err) {
    showSaveToast(err instanceof Error ? err.message : String(err), {
      isError: true,
      durationMs: 7000,
    });
  } finally {
    btnSave.disabled = !state.pdfDoc;
  }
}

async function promoteToSidePanel(): Promise<void> {
  if (!mcpConnected || state.pdfs.length === 0) return;
  btnPopPane.disabled = true;
  let openedDirectly = false;

  try {
    const zoomMode: ZoomMode =
      typeof state.zoomSetting === 'string' ? state.zoomSetting : 'fit-page';
    const promoRes = await app.callServerTool({
      name: 'promote_pdf_to_pane',
      arguments: {
        pdfIds: state.pdfs.map((p) => p.id),
        activeIndex: state.activeIndex,
        currentPage: state.currentPage,
        title: state.title,
        viewMode: state.viewMode,
        zoomMode,
      },
    });
    const promo = promoRes.structuredContent as unknown as PromotePdfResponse | undefined;
    if (!promoRes.isError && promo?.fileUri) {
      const toggleRes = await app.request(
        {
          method: 'com.google.antigravity/toggle-aux-pane',
          params: { tabType: 'fileView', uri: promo.fileUri },
        } as unknown as Parameters<typeof app.request>[0],
        z.object({ isError: z.boolean().optional() }).passthrough(),
      );
      if (!toggleRes?.isError) {
        openedDirectly = true;
      }
    }
  } catch {
    // Fallback below if host doesn't support toggle-aux-pane
  } finally {
    btnPopPane.disabled = false;
  }

  if (!openedDirectly && app.getHostCapabilities()?.message) {
    try {
      const active = state.pdfs[state.activeIndex];
      await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Open ${active.fileName} (page ${state.currentPage}) in the PDF Viewer side panel.`,
          },
        ],
      });
    } catch {
      // Ignore
    }
  }
}

// Event bindings
btnSidebar.addEventListener('click', () => {
  state.sidebarOpen = !state.sidebarOpen;
  sidebarEl.classList.toggle('hidden', !state.sidebarOpen);
  btnSidebar.classList.toggle('active', state.sidebarOpen);
  if (typeof state.zoomSetting === 'string' && state.zoomSetting !== 'actual') {
    void renderCurrentView(true);
  }
});

sideTabThumbs.addEventListener('click', () => {
  state.sidebarTab = 'thumbs';
  sideTabThumbs.classList.add('active');
  sideTabOutline.classList.remove('active');
  thumbsList.classList.remove('hidden');
  outlineList.classList.add('hidden');
});

sideTabOutline.addEventListener('click', () => {
  state.sidebarTab = 'outline';
  sideTabOutline.classList.add('active');
  sideTabThumbs.classList.remove('active');
  outlineList.classList.remove('hidden');
  thumbsList.classList.add('hidden');
});

btnPrev.addEventListener('click', () => stepPage(-1));
btnNext.addEventListener('click', () => stepPage(1));

pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = parseInt(pageInput.value, 10);
    if (!Number.isNaN(val)) {
      goToPage(val);
    } else {
      pageInput.value = String(state.currentPage);
    }
    pageInput.blur();
  }
});

pageInput.addEventListener('blur', () => {
  pageInput.value = String(state.currentPage);
});

for (const btn of [modeSingleBtn, modeSpreadBtn, modeScrollBtn]) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as ViewMode;
    if (mode === state.viewMode) return;
    state.viewMode = mode;
    void renderCurrentView();
  });
}

zoomSelect.addEventListener('change', () => {
  const v = zoomSelect.value;
  if (v === 'fit-width' || v === 'fit-page') {
    state.zoomSetting = v;
  } else {
    const n = parseFloat(v);
    if (!Number.isNaN(n)) state.zoomSetting = n;
  }
  void renderCurrentView(true);
});

function adjustZoom(factor: number): void {
  const next = Math.max(0.25, Math.min(4.0, Math.round(state.computedScale * factor * 20) / 20));
  state.zoomSetting = next;
  void renderCurrentView(true);
}

btnZoomIn.addEventListener('click', () => adjustZoom(1.2));
btnZoomOut.addEventListener('click', () => adjustZoom(1 / 1.2));

btnRotate.addEventListener('click', () => {
  state.rotation = (state.rotation + 90) % 360;
  void renderCurrentView(true);
});

function setSearchOpen(open: boolean): void {
  state.searchOpen = open;
  searchBar.classList.toggle('hidden', !open);
  btnSearch.classList.toggle('active', open);
  if (open) {
    searchInput.focus();
    searchInput.select();
  } else {
    state.searchQuery = '';
    state.searchMatches = [];
    state.activeMatchIdx = -1;
    searchInput.value = '';
    searchStatus.textContent = '';
    refreshAllTextHighlights();
  }
}

btnSearch.addEventListener('click', () => setSearchOpen(!state.searchOpen));
btnSearchClose.addEventListener('click', () => setSearchOpen(false));
btnSearchNext.addEventListener('click', () => stepSearch(1));
btnSearchPrev.addEventListener('click', () => stepSearch(-1));

let searchDebounce: number | undefined;
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => {
    void runSearch(searchInput.value);
  }, 180);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepSearch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    setSearchOpen(false);
  }
});

btnSave.addEventListener('click', () => {
  void savePdfLocally();
});

btnToastClose.addEventListener('click', () => {
  window.clearTimeout(toastTimer);
  saveToast.classList.add('hidden');
});

btnToastCopy.addEventListener('click', async () => {
  if (!lastSavedPath) return;
  try {
    await navigator.clipboard.writeText(lastSavedPath);
    btnToastCopy.textContent = 'Copied!';
    window.setTimeout(() => {
      btnToastCopy.textContent = 'Copy Path';
    }, 1800);
  } catch {
    btnToastCopy.textContent = 'Copy failed';
  }
});

btnReload.addEventListener('click', () => {
  const slot = state.pdfs[state.activeIndex];
  if (slot) {
    slot.initialPage = state.currentPage;
    void loadRegisteredPdf(slot, true);
  }
});

btnPopPane.addEventListener('click', () => {
  void promoteToSidePanel();
});

// Track current page while scrolling in Continuous Scroll mode
let scrollTrackRaf = 0;
stageEl.addEventListener('scroll', () => {
  if (state.viewMode !== 'scroll' || !state.pdfDoc) return;
  if (scrollTrackRaf) return;
  scrollTrackRaf = window.requestAnimationFrame(() => {
    scrollTrackRaf = 0;
    const stageTop = stageEl.getBoundingClientRect().top;
    let closestPage = state.currentPage;
    let bestDist = Infinity;
    pagesContainer.querySelectorAll<HTMLDivElement>('.page-wrapper').forEach((el) => {
      const rect = el.getBoundingClientRect();
      const dist = Math.abs(rect.top - stageTop - 24);
      if (dist < bestDist) {
        bestDist = dist;
        closestPage = Number(el.dataset.page);
      }
    });
    if (closestPage !== state.currentPage) {
      state.currentPage = closestPage;
      updateNavControls();
    }
  });
});

// Ctrl/Cmd + Wheel zoom
stageEl.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      adjustZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }
  },
  { passive: false },
);

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    if (state.pdfDoc) {
      e.preventDefault();
      setSearchOpen(true);
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    if (state.pdfDoc) {
      e.preventDefault();
      void savePdfLocally();
    }
    return;
  }

  if (inInput) return;
  if (!state.pdfDoc) return;

  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'j') {
    if (state.viewMode !== 'scroll' || e.key === 'ArrowRight') {
      e.preventDefault();
      stepPage(1);
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') {
    if (state.viewMode !== 'scroll' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stepPage(-1);
    }
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    adjustZoom(1.2);
  } else if (e.key === '-') {
    e.preventDefault();
    adjustZoom(1 / 1.2);
  } else if (e.key === '0') {
    e.preventDefault();
    state.zoomSetting = 'fit-page';
    void renderCurrentView(true);
  } else if (e.key === '/') {
    e.preventDefault();
    setSearchOpen(true);
  } else if (e.key.toLowerCase() === 't') {
    btnSidebar.click();
  } else if (e.key.toLowerCase() === 's') {
    state.viewMode = state.viewMode === 'spread' ? 'single' : 'spread';
    void renderCurrentView();
  } else if (e.key.toLowerCase() === 'c') {
    state.viewMode = state.viewMode === 'scroll' ? 'single' : 'scroll';
    void renderCurrentView();
  } else if (e.key.toLowerCase() === 'r') {
    btnRotate.click();
  } else if (e.key === 'Escape' && state.searchOpen) {
    setSearchOpen(false);
  }
});

// Resize observer so Fit Width / Fit Page adapts cleanly
let resizeTimer: number | undefined;
let lastStageW = 0;
let lastStageH = 0;
const ro = new ResizeObserver((entries) => {
  const rect = entries[0]?.contentRect;
  if (!rect) return;
  const dw = Math.abs(rect.width - lastStageW);
  const dh = Math.abs(rect.height - lastStageH);
  if (dw < 4 && dh < 4) return;
  lastStageW = rect.width;
  lastStageH = rect.height;
  if (state.pdfDoc && typeof state.zoomSetting === 'string' && state.zoomSetting !== 'actual') {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      void renderCurrentView(true);
    }, 120);
  }
});
ro.observe(stageEl);

// Drag & Drop + File Picker support
async function openDroppedFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    showError(`"${file.name}" is not a PDF file.`);
    return;
  }
  state.pdfs = [];
  state.localFileName = file.name;
  renderTabs();
  btnReload.classList.add('hidden');
  btnPopPane.classList.add('hidden');

  const buf = await file.arrayBuffer();
  await openPdfBytes(new Uint8Array(buf), file.name, buf.byteLength, 1);
}

filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  if (file) void openDroppedFile(file);
  filePicker.value = '';
});

let dragDepth = 0;
stageEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dragOverlay.classList.remove('hidden');
});
stageEl.addEventListener('dragover', (e) => {
  e.preventDefault();
});
stageEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOverlay.classList.add('hidden');
});
stageEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dragOverlay.classList.add('hidden');
  const file = e.dataTransfer?.files?.[0];
  if (file) void openDroppedFile(file);
});

// Apply host theme helper
function applyThemeFromContext(ctx: ReturnType<App['getHostContext']>): void {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.dataset.theme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

// Register MCP App handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  const label =
    (typeof args?.title === 'string' && args.title) ||
    (typeof args?.path === 'string' && args.path.split('/').pop()) ||
    'PDF';
  setLoading(`Opening ${label}…`, 10);
};

app.ontoolresult = (result) => {
  if (result.isError) {
    const errText =
      result.content
        ?.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join(' ')
        .trim() || 'Tool returned an error.';
    showError(errText);
    return;
  }

  const payload = result.structuredContent as unknown as ViewerPayload | undefined;
  if (!payload || typeof payload !== 'object') {
    showOverlay('empty');
    return;
  }

  if (payload.kind === 'session') {
    applySessionPayload(payload);
  } else if (payload.kind === 'file_viewer') {
    void applyFileViewerPayload(payload);
  } else {
    showOverlay('empty');
  }
};

app.onhostcontextchanged = (ctx) => {
  applyThemeFromContext(ctx);
};

async function init(): Promise<void> {
  try {
    await app.connect();
    mcpConnected = true;
    applyThemeFromContext(app.getHostContext());
  } catch {
    mcpConnected = false;
    showOverlay('empty');
  }
}

void init();
