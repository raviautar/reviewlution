import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The package's entries as ES modules for other apps to import: the toolbar
// component (`.`), the API handler (`./server`) and its two stores. React
// stays the host's (a peer), as do Supabase's client and Node's built-ins;
// modern-screenshot is installed with the package and loaded only when a phone
// capture runs. Only the component is marked client-only, for React Server
// Components hosts; the server entries must stay importable on the server.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: {
        lib: 'src/lib.tsx',
        'server/index': 'src/server/index.ts',
        'store/file': 'src/store/file.ts',
        'store/supabase': 'src/store/supabase.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/, 'modern-screenshot', /^@supabase\//, /^node:/],
      output: {
        banner: (chunk) => (chunk.isEntry && chunk.name === 'lib' ? "'use client';" : ''),
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
