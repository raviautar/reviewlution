import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served under /__review/ so every other path on the host can proxy the app.
export default defineConfig({
  base: '/__review/',
  plugins: [react()],
});
