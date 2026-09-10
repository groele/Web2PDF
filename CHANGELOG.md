# Changelog

## v3.0.0 - 2026-09-10

### Added

- Added a user-selectable export format: high-quality PDF, lossless PNG, or JPEG image.
- Added an optional download filename field with automatic cleanup of unsupported filename characters.
- Added persistent output-format preferences and consistent option propagation to automatic recognition and manual region selection.
- Added accessible live status feedback and a clear disabled state when export is unavailable on the current page.

### Changed

- Promoted the extension to a major release focused on a professional, general-purpose web-region export workflow.
- Kept PDF layout options visible only when relevant and clarified that image export produces a single complete image.

### Fixed

- Corrected custom filename handling for both automatic and manual export flows.
- Removed duplicate format listeners and unreachable status logic before release.

### Compatibility

No user migration is required. Existing local export preferences remain valid.

## v2.6.0 - 2026-09-10

### Added

- Applied the saved PDF, PNG, or JPEG format preference to the Web of Science floating controls.
- Added a clear guidance note for heuristic automatic content recognition.

### Fixed

- Kept exported image format consistent between the popup and in-page export entry points.

## v2.5.0 - 2026-09-10

### Added

- Added direct PNG and JPEG export at the selected 2x, 3x, or 4x render scale.
- Added a persistent output-format selector in the popup.
- Added a new source SVG and regenerated 16px, 48px, and 128px extension icons.

### Changed

- Hide PDF-only layout controls while exporting an image.

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
