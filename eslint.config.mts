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
    {
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'error',
                {
                    prefer: 'type-imports',
                    fixStyle: 'separate-type-imports',
                },
            ],
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'rxjs/operators',
                            message:
                                "Import operators from the 'rxjs' root; the 'rxjs/operators' entry point is deprecated.",
                        },
                    ],
                },
            ],
        },
    },
    eslintConfigPrettier,
];
