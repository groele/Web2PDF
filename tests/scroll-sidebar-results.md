# Independent sidebar capture verification

## Targeted regression pass — 2026-09-11

`tests/export-regression.js`: 25/25 browser assertions passed.
Lifecycle coverage includes duplicate-launch reuse, pending-export rejection, and the v3.5.0 content handshake.

- Custom div drawer/title detection; ordinary article not promoted to nested scrolling table.
- Real 800 x 2320 PNG render with the green final section intact, ignored nodes, JSON script, and modern pseudo-element colors.
- Live sidebar scrollTop remains 200 and live height remains 800; no capture identifiers or clone frame left behind.
- Real jsPDF output: 3 pages, `%PDF-1.3` header, no page-number text calls.
- Renderer and clone callback failures: selection retained, retry succeeds, clone frame cleaned.
- Controlled paused rendering: attempted internal scroll from 200 to 350 is restored to 200; after export, scrolling to 350 works.
- 360px viewport: wrapping controls remain reachable; mode switching and cancel cleanup pass.
- 10 x 10 selection, bottom-edge keyboard resize to 10 x 9, translation, and 20 x 18 output at 2x all agree.
- Intentional overflow-hidden content is not expanded as a scroll container.
- Actual encoded PNG/JPEG with top/bottom/left/right margins 1/3/2/4 mm: 245 x 231 pixels at 2x, white corner and green center verified by decoding the generated blobs.
- Export PNG was visually inspected for title, content order, retained clipping and final section. PDF page layout has not been visually reviewed.
- Native browser events downloaded both `native-download-test.png` and `native-pdf-test.pdf` without a browser-reported failure.
- A 12,000px drawer requested at 4x was safely reduced to 2.73x and rendered as 1092 x 32766, below the configured canvas edge limit.
- Popup mismatch test: a v3.5.0 popup connected to a v3.4.0 page script shows an explicit refresh error and disables both launch buttons instead of reinjecting another picker.

The scroll-lock test originally failed even with rendering paused. It passed after adding a position watchdog and restoring confirmed nested-scroll coordinates in the clone. This is a production fix, not a relaxed assertion.

## Earlier checks

Local Chromium with the bundled html2canvas; extension message boundary mocked.
This is not a real authenticated WOS / installed-extension end-to-end test.

- Directly scrolling fixed drawer: PNG 800 x 2378; bottom pixel RGBA 0,200,0,255.
- Flex drawer with 60px header and independently scrolling body: PNG 800 x 2320; bottom pixel RGBA 0,200,0,255.
- Selecting the header identifies the sibling scroll body through the drawer ancestor.
- Before and after the flex-drawer export: scrollTop 200; live drawer height 800.
- Page rectangle mode remains separately selectable; full-scroll mode intentionally keeps original width.
- PDF pagination now obtains block boundaries from expanded clone; PDF visual verification remains pending.

Known verification gaps: real WOS markup, lazy-loaded rows/images, shadow DOM, and cross-origin frames.
