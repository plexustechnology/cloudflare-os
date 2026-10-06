import { defineConfig } from 'vite'

/** One self-contained script: the public landing page needs no protected SPA chunks or CDN. */
export default defineConfig({
  build: {
    outDir: 'dist/teams/sign-in',
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: 'src/features/teams/teamsAccessBootstrap.ts', formats: ['iife'], name: 'PlexusTeamsAccess' },
    rollupOptions: { output: { entryFileNames: 'bootstrap.js', inlineDynamicImports: true } },
  },
})
