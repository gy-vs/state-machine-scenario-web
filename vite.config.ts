import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: { outDir: '../dist', emptyOutDir: true },
  test: {
    root: '.',
    include: ['server/**/*.test.ts'],
    environment: 'node',
  },
});
