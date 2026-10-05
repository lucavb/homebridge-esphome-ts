import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
    {
        ignores: ['dist', 'coverage', 'node_modules'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
];
