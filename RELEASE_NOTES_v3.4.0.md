# v3.4.0 — Selection adjustment and export audit

## Improvements

- Both smart detection and manual selection now open an adjustment panel before export.
- Top and bottom handles crop within the selected element; focused handles support 1 px arrow-key steps or 10 px with Shift.
- Reopening selection closes the previous adjustment panel. Export work is guarded against concurrent requests.
- Controls remain in the viewport on long pages and wrap on narrow screens.
- Small selections retain their true height. Scroll coordinates follow the target element.
- A4 break candidates subtract the cropped top offset. Small adaptive images retain their aspect ratio; oversized adaptive pages fall back to A4.
- Popup initialization disables actions until the page is ready and checks readiness again before dispatch.
- Version declarations and usage guidance are aligned. Other websites use activeTab rather than persistent all-sites permission.

## Verification on 2026-09-11

Browser tests used the real content script, stylesheet, bundled html2canvas and jsPDF on a local controlled page. The Chrome messaging boundary was stubbed; this was not an installed-extension end-to-end test.

| Check | Observed result |
| --- | --- |
| First click | One adjustment frame; zero downloads |
| Drag both edges on a 400 × 400 CSS px fixture | 800 × 400 PNG at 2× after retaining 200 CSS px |
| PNG content | Interior pixel [0, 255, 0, 255], matching retained green band |
| Scroll by 50 px | Frame moved from viewport y=100 to y=50 |
| Shift + Down on top handle | Top moved 10 px; height reduced from 400 to 390 |
| Repeat smart detection | Exactly one frame |
| Escape | Zero frames |
| Reselect | Picker banner restored |
| 360 × 640 viewport | Control panel stayed within viewport |
| Cropped A4 export after scrolling | Real PDF bytes, %PDF-1.3 header, 3 pages, approximately 210 × 297 mm |
| Small adaptive export | 200 × 20 CSS px selection; one-page PDF approximately 64.9 × 17.3 mm including margins |

## Remaining limitations

- Installed Chrome/Edge extension loading, popup permission prompts, and external website compatibility still require acceptance testing.
- Cropping currently renders the whole selected element first. Very long targets can still exceed memory limits.
- Only vertical cropping within the initial element is supported. Arbitrary expansion, horizontal cropping and drag-triggered autoscroll are not included.
- Cross-origin images, embedded frames and complex page layouts remain subject to html2canvas and browser constraints.
- The PDF is rasterized, not selectable text. Browser tests inspected generated PDF bytes and dimensions, not a PDF viewer rendering.

## Update

Reload the extension in the browser extension manager and refresh existing tabs. Existing saved options remain compatible.
