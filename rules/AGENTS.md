# Default Inline PDF Viewer

When the user asks to view, open, preview, or display a local `.pdf` file in Jetski, **use the `pdf-viewer` plugin by default**:

- **Inline in chat (default)**: Call `view_pdf_inline` with the absolute `path` (or up to 5 PDFs in `files`) to render an interactive PDF viewer directly inside the conversation, with page navigation, zoom, text selection, search, thumbnails, outline, 2-page book spread, and a one-click button to pop into the side panel.
- **Full-height side panel**: Call `open_pdf_viewer` when the user explicitly asks to open a PDF in the side panel (calling it again updates the open panel in place).
- Do not launch external desktop viewers (`open`) or generate ad-hoc HTML files to show PDFs unless the user explicitly asks for them.
