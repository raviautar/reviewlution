import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The in-page component (src/lib.tsx) as an ES module for other apps to
// import. React stays the host's (a peer dependency) and modern-screenshot is
// installed with the package, loaded only when a phone capture runs. The
// banner marks the module as client-only for React Server Components hosts.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/lib.tsx',
      formats: ['es'],
      fileName: () => 'lib.js',
    },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/, 'modern-screenshot'],
      output: { banner: "'use client';" },
    },
  },
});
