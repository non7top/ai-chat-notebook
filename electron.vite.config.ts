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

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main.ts' },
        external,
      },
    },
  },
  preload: {
    build: {
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
    build: {
      rollupOptions: {
        input: 'index.html',
      },
    },
    plugins: [react()],
  },
});
