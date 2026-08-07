// Preload for the embedded AI Mode WebContentsView — separate from the app's
// own preload (src/preload.ts), and deliberately kept minimal: this runs
// inside a page holding a live Google session, so it should never expose more
// than the capture path actually needs.
//
// The capture bridge itself lands with live capture (task 6). For now this
// only confirms, in the view's DevTools, that a preload runs in a given frame
// at all — which is exactly the question the recon spike has to answer before
// any injected script can be relied on.
console.log(
  `[Notebook] aiModePreload loaded (mainFrame=${process.isMainFrame}, url=${location.href})`,
);
