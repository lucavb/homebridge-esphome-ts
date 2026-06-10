// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.strict,

    {
        ignores: ['dist/**/*', 'node_modules/**/*', 'src/types/**/*.d.ts'],
    },

    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: 'module',
        },
        rules: {
            'dot-notation': 'off',
            eqeqeq: 'warn',
            curly: ['warn', 'all'],
            'prefer-arrow-callback': ['warn'],
            'no-console': ['warn'],
            'no-multi-spaces': ['warn', { ignoreEOLComments: true }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },

    {
        files: ['**/*.spec.ts', '**/*.test.ts', '**/__tests__/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },
);
