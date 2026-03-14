import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
    root: resolve(__dirname),
    build: {
        outDir: resolve(__dirname, '..', 'dist', 'web'),
        emptyOutDir: true,
    },
    server: {
        port: 3000,
        headers: {
            // Required for SharedArrayBuffer if we ever enable threading
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
    },
    optimizeDeps: {
        exclude: ['../core/build/snes9x_libretro.mjs'],
    },
});
