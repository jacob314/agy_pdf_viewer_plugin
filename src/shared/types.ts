export type ViewerLayout = 'inline' | 'pane';
export type ViewMode = 'single' | 'spread' | 'scroll';
export type ZoomMode = 'fit-width' | 'fit-page' | 'actual';

export interface PdfSlotMeta {
  id: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  initialPage: number;
  streamUrl?: string;
}

export interface PdfSessionPayload {
  kind: 'session';
  sessionId: string;
  layout: ViewerLayout;
  title: string;
  activeIndex: number;
  viewMode: ViewMode;
  zoomMode: ZoomMode;
  inlineHeight: number;
  pdfs: PdfSlotMeta[];
}

export interface PdfFileViewerPayload {
  kind: 'file_viewer';
  layout: 'pane';
  file: {
    name: string;
    resourceUri: string;
  };
}

export type ViewerPayload = PdfSessionPayload | PdfFileViewerPayload;

export interface ResolvePdfSourceResponse {
  pdfId: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  streamUrl?: string;
}

export interface LoadPdfChunkResponse {
  pdfId: string;
  fileName: string;
  totalBytes: number;
  mtimeMs: number;
  offset: number;
  length: number;
  chunkIndex: number;
  totalChunks: number;
  dataBase64: string;
}

export interface PromotePdfResponse {
  fileUri: string;
  fileName: string;
}

export interface SavePdfResponse {
  savedPath: string;
  fileName: string;
  sizeBytes: number;
}
