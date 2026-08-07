/// <reference types="vite/client" />

import type { NotebookApi } from './src/shared/types';

declare global {
  interface Window {
    notebook: NotebookApi;
  }
}
