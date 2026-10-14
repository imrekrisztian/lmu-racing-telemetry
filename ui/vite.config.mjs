import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
    root: path.resolve(import.meta.dirname),
    // Relative, because production loads over file:// from Electron.
    base: './',
    plugins: [react()],
    server: { port: 5273, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true },
});
