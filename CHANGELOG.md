# Changelog

## v3.5.0 - 2026-09-11

### Targeted export reliability
- Reuse an existing picker/adjuster instead of reopening it; reject launch requests while a file is rendering.
- Add popup/content version handshake so stale page scripts request a page refresh instead of reinjecting conflicting UI.
- Verify native browser PNG and PDF download events, plus high-resolution 12,000px drawer downscaling within the canvas edge limit.
- Detect custom fixed drawers without mistaking an article's nested table for the export target.
- Expand actual scroll containers and their wrappers only; keep intentional clipping intact.
- Map clone nodes with temporary capture identifiers, independent of ignored nodes and pseudo-elements; clean identifiers and clone frames on failure.
- Restore confirmed scroll positions inside the clone and verify live positions during export, including delayed scroll events.
- Preserve the selection after a failed export, support retry, and display continuous export status.
- Make guidance click-through; wrap narrow-screen controls and clarify estimated full-scroll dimensions.
- Align small-size inputs, keyboard movement and focused-edge resizing with the actual output rectangle.
- Restore no-page-number PDF output and honor lossless PNG encoding without automatic JPEG substitution.
- Synchronize floating format labels with saved preferences; avoid duplicate file extensions.
- Add repeatable browser regression coverage using bundled html2canvas and jsPDF.

### Sticky toolbar correction
- Exclude compact top or bottom fixed/sticky action groups regardless of scroll position.
- Recognize WOS full-text/export/marked-list groups even when only an outer wrapper is positioned.

### Overlay cleanup
- Hide bottom fixed/sticky action docks in the capture clone so website toolbars do not obscure article text; retain document layout and the original live page.

### Capture stability
- Freeze viewport coordinates before asynchronous asset loading, block scroll input while exporting, and release listeners on success or failure.

### Scroll alignment
- Update the active edge during wheel scrolling while dragging, keeping the opposite edge anchored.
- Position hover guides in viewport coordinates to avoid body-margin and positioning offsets.

### Color compatibility
- Convert modern CSS colors to sRGB in the capture clone for html2canvas 1.4 compatibility, including gradients, shadows and pseudo-elements. The original page is not modified.

### Interface
- Redesign popup as three numbered sections with a scrollable settings area and persistent action footer.
- Add margin diagram, format-dependent defaults, keyboard focus styles and accessible toggle states.
- Replace floating selection controls with a compact bottom-right dock and collapsible help.
- Serialize preference writes; guard repeated launches and keep retryable errors inside the popup.

### Fixed
- Remove initial-element bounds from vertical dragging and numeric sizing.
- Capture the page rectangle so expanded selections include adjacent elements.
- Add pointer capture, edge autoscroll, blur cleanup and larger handle hit areas.
- Avoid covering handles with the enlarged size control panel where space permits.

### Added
- Independent saved margins and editable selection width/height.

## v3.4.0 - 2026-09-11

### Added
- Confirm selection before export; drag top/bottom handles or use arrow keys for precise cropping.
- Smart detection and manual picking share the adjustment workflow.

### Fixed
- Offset A4 page-break candidates after top cropping.
- Keep controls visible on long pages and narrow viewports; clean up repeated selection sessions.
- Prevent overlapping exports and detect changed target dimensions before export.
- Preserve small-image aspect ratios; fall back to A4 when adaptive PDF dimensions exceed limits.
- Correct capture scroll coordinates and remove redundant all-sites permission.

### Changed
- Align popup guidance and version metadata; retain activeTab access for user-selected pages.

### Compatibility
- Existing settings remain supported. Reload the extension and refresh existing tabs.

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
