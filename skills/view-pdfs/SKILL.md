---
name: view-pdfs
description: >-
  View, inspect, and compare local PDF files inline in chat or in the
  full-height PDF Viewer side panel inside Jetski using the pdf-viewer plugin.
  Use whenever the user asks to view, open, preview, inspect, or flip through a
  PDF file, or right after generating/exporting a PDF document.
---

# Viewing PDFs Inline in Jetski

Use the **`pdf-viewer`** MCP server tools (`pdf-viewer_pdf_viewer`) to display local `.pdf` files interactively inside Jetski — right in the chat conversation or in the full-height side panel.

## Choosing Inline vs. Side Panel

| Tool | Surface | When to Use |
| :--- | :--- | :--- |
| **`view_pdf_inline`** | **Inline Chat Card** — *Default for inline viewing* | Displays an interactive PDF viewer directly inside the conversation (~640px tall, configurable 320–780px). Includes a one-click **Side Panel ↗** button to promote to full height at the exact same page. |
| **`open_pdf_viewer`** | **Side Panel (`aux_pane`)** | Full-height interactive reading/inspection, side-by-side book spreads, or when the user asks to open a PDF in the side panel. Calling it again updates the open panel in place. |

## Key Features
- **Crisp Retina rendering** via embedded PDF.js (100% offline/self-contained, works on large 50–150+ MB print PDFs via chunked streaming).
- **Selectable text layer** for copying text directly from the inline preview.
- **In-document full-text search** (`/` or `⌘F`) with match counter and yellow/orange page highlights.
- **3 view modes**: Single Page (`single`), 2-Page Book Spread (`spread` — cover solo, then 2–3, 4–5…), and Continuous Scroll (`scroll`).
- **Collapsible sidebar** with lazy-rendered page thumbnails and PDF Table of Contents (Outline) bookmarks.
- **Multi-PDF tabs**: Pass up to 5 PDFs in `files` to switch between revisions or documents in one viewer.
- **Zoom & rotation**: Fit Width, Fit Page, 50%–300%, `⌘/Ctrl` + scroll wheel zoom, and 90° rotation.
- **Save Locally (`⌘S`)**: One-click button in the toolbar saves a non-clobbering local copy into `~/Downloads` (works for both registered disk PDFs and clicked/dropped PDFs).
- **Click-to-open `.pdf` files**: Registers a custom `.pdf` file viewer entrypoint so clicking any `.pdf` file opens it directly in the interactive viewer.

## Calling the Tools

Single PDF inline:
```json
{
  "path": "/absolute/path/to/document.pdf",
  "page": 1,
  "viewMode": "single",
  "zoom": "fit-width"
}
```

Book / print proof as a 2-page spread:
```json
{
  "path": "/absolute/path/to/storybook.pdf",
  "page": 2,
  "viewMode": "spread",
  "zoom": "fit-page"
}
```

Compare up to 5 PDFs in tabs:
```json
{
  "title": "Print Proof Comparison",
  "files": [
    { "path": "/abs/path/v1.pdf", "label": "Draft v1" },
    { "path": "/abs/path/v2.pdf", "label": "Final v2", "page": 3 }
  ],
  "activeIndex": 1
}
```

### Arguments Reference
- `path` *(string, optional)*: Absolute path to a single `.pdf` file.
- `files` *(array, 1–5 items, optional)*: List of `{ path, label?, page? }` objects for multi-PDF tabs.
- `page` *(integer ≥ 1, optional)*: Initial 1-based page number (default `1`).
- `activeIndex` *(integer 0–4, optional)*: Initially active tab index when `files` is provided (default `0`).
- `title` *(string, optional)*: Header title override.
- `viewMode` *(`"single"` | `"spread"` | `"scroll"`, optional)*: Page layout (default `"single"`).
- `zoom` *(`"fit-width"` | `"fit-page"` | `"actual"`, optional)*: Initial zoom mode (default `"fit-width"`).
- `height` *(integer 320–780, optional)*: Inline frame height in pixels (default `640`; ignored in side panel).

## Best Practices
- Always pass **absolute file paths**.
- Prefer `view_pdf_inline` when the user wants to view or preview a PDF inline in the conversation, and `open_pdf_viewer` when they ask for the side panel or full-height view.
- For illustrated books or print proofs, `viewMode: "spread"` with `zoom: "fit-page"` gives a natural two-page book layout.
- Do not launch external desktop apps (`open`) or export PDF pages to temporary PNGs just to show a PDF to the user unless they explicitly ask for image exports or visual pixel inspection by the agent.
