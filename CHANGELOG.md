# Changelog

## v2.4.0 - 2026-09-10

### Added

- Added preview-and-confirm flow for automatic content recognition.
- Added page numbers and document metadata to A4 PDF output.
- Added content-aware page-break selection for common document blocks.

### Changed

- Renamed the extension to Web Region PDF Exporter / 网页区域 PDF 导出器.
- Added adaptive render limits and a safe fallback for oversized continuous pages.
- Wait for web fonts and pending images before rendering.
- Reduced default host access to Web of Science and Clarivate; other sites use user-initiated active-tab access.

### Fixed

- Prevented tainted canvases from failing during PDF image serialization.
- Loaded saved export preferences before the first export action.

### Compatibility

Backward compatible; no migration required.
