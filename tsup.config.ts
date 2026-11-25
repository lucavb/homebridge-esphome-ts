import { defineConfig } from 'tsup';

/**
 * The package ships a single ESM bundle with its runtime dependencies inlined.
 *
 * bonjour-hap, esphome-ts, rxjs, and zod are build-time dependencies; consumers
 * install none of them. `homebridge` is type-only. The package is ESM ("type":
 * "module"), so tsup emits `.js` (not `.mjs`).
 *
 * The `createRequire` banner is required because bonjour-hap and its transitive
 * dependencies are CommonJS; their `require()` calls need a Node ESM require.
 * Built-ins stay external.
 */
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: 'dist',
    clean: true,
    dts: true,
    sourcemap: true,
    minify: false,
    splitting: false,
    treeshake: true,
    skipNodeModulesBundle: false,
    banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    esbuildOptions(options) {
        // Keep the source map useful without embedding every dependency's source.
        options.sourcesContent = false;
    },
});
