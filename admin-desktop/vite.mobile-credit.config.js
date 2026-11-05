import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], publicDir: false, build: { outDir: '../customer-web/public/manager/credit-assets', emptyOutDir: true, rollupOptions: { input: 'src/mobile-credit.jsx', output: { entryFileNames: 'credit.js', assetFileNames: 'credit.[ext]' } } } });
