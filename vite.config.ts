import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(process.cwd(), 'app/index.html'),
        admin: resolve(process.cwd(), 'app/admin.html')
      }
    }
  }
});
