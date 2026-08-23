/// <reference types="vite/client" />

import type { NotebookApi } from './src/shared/types';

declare global {
  interface Window {
    notebook: NotebookApi;
  }

  /**
   * Replaced at build time by electron.vite.config.ts. True only for builds CI
   * makes for a pull request, which turn remote debugging on by default; false
   * in a release, where it stays an explicit opt-in.
   */
  const __DEBUG_BUILD__: boolean;
}
