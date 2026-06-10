import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    minify: false,
    target: 'node22',
    platform: 'node',
    fixedExtension: true,
    outDir: 'dist',
    treeshake: false,
    deps: {
        neverBundle: ['homebridge', 'esphome-ts', 'bonjour-hap', 'rxjs', 'ip'],
    },
});
