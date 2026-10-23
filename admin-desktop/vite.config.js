import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  publicDir: path.resolve(__dirname, '../sounds'),
  plugins: [react()],
  server: {
    port: 3002,
    host: '0.0.0.0'
  }
});
