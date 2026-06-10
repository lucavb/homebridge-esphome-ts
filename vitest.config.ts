/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        exclude: ['node_modules', 'dist', '**/*.d.ts'],
        globals: true,
        typecheck: {
            tsconfig: './tsconfig.spec.json',
        },
    },
});
