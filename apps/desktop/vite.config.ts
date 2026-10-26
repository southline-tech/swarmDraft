import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Tauri expects a fixed dev port and must not clear the terminal.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', outDir: 'dist' },
  test: { environment: 'happy-dom' },
});
