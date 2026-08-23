import { builtinModules } from 'node:module';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Only Electron itself and Node builtins are external — everything else gets
// bundled straight into out/main/index.js, so the packaged app needs no
// node_modules at runtime at all.
const external = [
  'electron',
  'node:sqlite',
  ...builtinModules,
  ...builtinModules.map((mod) => `node:${mod}`),
];

// Baked in at build time, not read from the environment at runtime: a release
// must not be turnable into a debug build by setting a variable, and a PR build
// must not quietly lose the setting depending on how it was launched.
//
// CI sets this for pull-request builds only. Releases are built without it, so
// they ship with remote debugging off and it stays an explicit opt-in there —
// which matters, because the endpoint is unauthenticated and the embedded panel
// holds a live Google session.
const debugBuild = process.env.NOTEBOOK_DEBUG_BUILD === '1';

export default defineConfig({
  main: {
    // electron-vite auto-adds its own externalize-deps plugin unless told not
    // to (build.externalizeDeps defaults to true). It externalizes every
    // package.json "dependencies" entry as a bare require(), with no regard
    // for the `external` allowlist above — so the comment above is a lie
    // without this line. Verified concretely here, not taken on trust: with
    // the default left on, out/main/index.js contained
    // require("electron-context-menu"), and since electron-builder.yml ships
    // no node_modules that crashes the packaged app at startup (contextMenu()
    // is called at module top level in src/main.ts, so it isn't even deferred
    // to the first right-click).
    define: {
      __DEBUG_BUILD__: JSON.stringify(debugBuild),
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: 'src/main.ts' },
        external,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Two independent preloads: the app's own, and a separate one for the
        // embedded AI Mode WebContentsView (see src/main/aiModeView.ts).
        input: {
          preload: 'src/preload.ts',
          aiModePreload: 'src/aiModePreload.ts',
        },
        output: {
          entryFileNames: '[name].js',
        },
        external,
      },
    },
  },
  renderer: {
    root: '.',
    define: {
      __DEBUG_BUILD__: JSON.stringify(debugBuild),
    },
    build: {
      rollupOptions: {
        input: 'index.html',
      },
    },
    plugins: [react()],
  },
});
