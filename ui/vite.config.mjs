import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
    root: path.resolve(import.meta.dirname),
    // Relative, because production loads over file:// from Electron.
    base: './',
    plugins: [react()],
    // Strategy logic is shared with the main process rather than duplicated in
    // the renderer, so vite must be allowed to read outside ui/.
    server: { port: 5273, strictPort: true, fs: { allow: [path.resolve(import.meta.dirname, '..')] } },

    build: { outDir: 'dist', emptyOutDir: true },
});
