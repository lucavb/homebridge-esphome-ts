import { describe, expect, it } from 'vitest';

import { isRecord } from './typeguards.js';

describe('isRecord', () => {
    it('returns true for plain objects', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ key: 'value' })).toBe(true);
        expect(isRecord(Object.create(null))).toBe(true);
    });

    it('returns false for arrays', () => {
        expect(isRecord([])).toBe(false);
        expect(isRecord([1, 2])).toBe(false);
    });

    it('returns false for primitives and nullish values', () => {
        expect(isRecord(null)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        expect(isRecord(0)).toBe(false);
        expect(isRecord('')).toBe(false);
        expect(isRecord(true)).toBe(false);
        expect(isRecord(42)).toBe(false);
    });
});
