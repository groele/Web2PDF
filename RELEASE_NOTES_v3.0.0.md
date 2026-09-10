# Web Region PDF Exporter v3.0.0

## Release overview

Version 3.0.0 is the major release milestone for a general-purpose web-region exporter. It provides high-resolution PDF output, direct PNG/JPEG image export, optional filenames, automatic content recognition with a confirm step, and manual region selection.

## Breaking changes

No known end-user breaking changes. The major version marks a product capability milestone rather than a required migration.

## Configuration and data

The popup persists the selected output format in browser local storage (`wos_output_format`). The optional filename is used only for the active download and is not uploaded or retained by the extension. Existing local export preferences remain compatible.

## Migration

No migration is required. Reload the unpacked extension from Chrome or Edge's extension management page, refresh the target tab, then choose PDF, PNG, or JPEG before exporting.

## Compatibility limits

PDF output is generated from a high-resolution webpage raster rather than selectable vector text. Extremely long regions can require reduced render scale or PDF pagination. Cross-origin images without CORS permission may be absent because of browser security controls. Automatic recognition is heuristic; use manual selection whenever the proposed region is not correct.

## Verification completed

- JavaScript syntax checks for `content.js` and `popup.js`.
- Manifest JSON parsing.
- Static assertions for version consistency, one filename-cleaning helper, option propagation, and removed duplicate listeners.
- Whitespace/diff checks and icon dimension inspection.

A live browser extension end-to-end export on a target website was not performed in this release environment; it remains the recommended final smoke test after loading the packaged extension.

## Rollback and backup

The previous public release remains available at tag `v2.6.0`. To roll back an unpacked installation, check out that tag and reload the extension. Browser local preferences are backward compatible and need no reset.
