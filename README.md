# Antigravity Inline PDF Viewer Plugin

An interactive [Antigravity](https://antigravity.google) / Jetski plugin (`pdf-viewer`) that bundles a self-contained **MCP App** (offline PDF.js), an **always-on default viewer rule**, and the **`view-pdfs` skill** for viewing, searching, comparing, and saving local `.pdf` files directly **inline in chat**, in the **full-height side panel**, or by **clicking any `.pdf` file**.

---

## Features

- **Inline Chat, Side Panel, & Click-to-Open File Handler**:
  - **Inline Chat Viewer (`view_pdf_inline`)**: Renders 1–5 `.pdf` files right inside the conversation with a one-click **Side Panel ↗** button that promotes the exact document, current page, view mode, and zoom straight into the side panel.
  - **Side Panel (`open_pdf_viewer`)**: Full-height auxiliary side pane (`PDF Viewer`) launchable from the side pane `+` menu or via tool calls (remembers the last session or accepts drag-and-drop PDFs).
  - **Custom `.pdf` File Viewer (`view_pdf_file`)**: Automatically claims `.pdf` files so clicking any PDF link or file in Antigravity opens it directly in the interactive PDF Viewer.
- **Fast On-Demand Byte-Range Streaming**:
  - Powered by bundled offline **PDF.js** (zero external network or CDN requests; runs cleanly under strict `default-src 'none'` CSP).
  - PDFs over 4 MB automatically stream on demand via `PDFDataRangeTransport` in ≤512 KiB slices, so even **300+ MB** illustrated print books open in seconds without loading the entire file into memory.
- **Save Locally (`⌘S` / Download button)**:
  - One-click save to `~/Downloads` with non-clobbering filenames (`file.pdf`, `file_2.pdf`, …) and a copy-path confirmation toast—works for registered disk PDFs (instant copy even for 300+ MB files), clicked `file_viewer` PDFs, and drag-and-dropped files.
- **Rich Reading & Layout Tools**:
  - **3 View Modes**: Single Page, **2-Page Book Spread (`S`)** (cover solo, then 2–3, 4–5…), and **Continuous Scroll (`C`)** with lazy rendering.
  - **Selectable Text Layer & Full-Text Search (`/` or `⌘F`)**: Copy text directly from rendered pages or search across the entire document with match counts and yellow/orange highlights.
  - **Collapsible Sidebar (`T`)**: Lazy-rendered page thumbnails and clickable PDF Outline / Table of Contents bookmarks.
  - **Zoom & Rotation**: Fit Width (`0`), Fit Page, 50%–300%, `+` / `-`, `⌘`/Ctrl + scroll wheel, and 90° clockwise rotation (`R`).
  - **Multi-PDF Tabs**: Pass up to 5 PDFs to compare revisions or documents side-by-side in tabs.

---

## Installation

Pre-built bundles (`dist/index.html` and `dist/server.mjs`) are checked into this repository so the plugin works immediately with **Node.js 20+** and no build step required.

Clone directly into your Antigravity global plugins directory:

```bash
git clone https://github.com/jacob314/agy_pdf_viewer_plugin.git ~/.gemini/config/plugins/pdf-viewer
```

Antigravity automatically discovers any plugin with a `plugin.json` under `~/.gemini/config/plugins/`. Once cloned:
- The **`pdf-viewer`** plugin, **`view-pdfs`** skill, **always-on default viewer rule** (`rules/AGENTS.md`), and **`pdf_viewer`** MCP server activate automatically.
- You can manage or toggle the plugin anytime from **Customizations → Plugins → Inline PDF Viewer**.

---

## Usage

Ask Antigravity in any chat to view or inspect a PDF:

- *"View `report.pdf` inline right here in the chat"*
- *"Open my 8.5×11 storybook PDF in a 2-page book spread"*
- *"Open `manual.pdf` in the PDF Viewer side panel at page 12"*

Or simply **click any `.pdf` file** in Antigravity to open it directly in the PDF Viewer.

### Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| **`←` / `→`** or **`k` / `j`** | Previous / Next page (or spread) |
| **`+` / `-`** or **`⌘` + Scroll** | Zoom in / out |
| **`0`** | Fit Width |
| **`S`** | Toggle **2-Page Book Spread** |
| **`C`** | Toggle **Continuous Scroll** |
| **`T`** | Toggle **Thumbnails & Table of Contents** sidebar |
| **`/`** or **`⌘F`** | Open **Search** bar (`Enter` / `Shift+Enter` to step matches) |
| **`R`** | Rotate 90° clockwise |
| **`⌘S` / `Ctrl+S`** | **Save PDF copy locally** to `~/Downloads` |

---

## MCP Tools

| Tool | Visibility | Surface | Purpose |
| :--- | :--- | :--- | :--- |
| `view_pdf_inline` | Model & App | Inline Chat | Interactive inline PDF viewer for 1–5 files with zero-turn **Side Panel ↗** promotion |
| `open_pdf_viewer` | Model & App | Side Panel (`aux_pane`) | Full-height side-panel viewer; restores last session on `{}` |
| `view_pdf_file` | Host / App | File Viewer (`file`) | Custom click-to-open `.pdf` file handler |
| `load_pdf_chunk` | App-only | Internal | Streams ≤512 KiB chunks or arbitrary byte ranges for `PDFDataRangeTransport` |
| `promote_pdf_to_pane` | App-only | Internal | Snapshots inline state (tabs, page, zoom, view mode) for instant `toggle-aux-pane` handoff |
| `save_pdf_locally` | App-only | Internal | Fast server-side copy of a registered PDF into `~/Downloads` |
| `save_pdf_chunk` | App-only | Internal | Chunked local saver to `~/Downloads` for `file_viewer` or dropped PDFs |

---

## Development

```bash
npm install
npm run typecheck
npm run build
```

## License

Licensed under the [Apache License 2.0](LICENSE).
