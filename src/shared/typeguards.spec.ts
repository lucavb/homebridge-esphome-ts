import { describe, expect, it } from 'vitest';

import { isRecord } from './typeguards';

describe('isRecord', () => {
    it('returns true for plain objects', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ key: 'value' })).toBe(true);
    });

    it('returns false for non-objects', () => {
        expect(isRecord(null)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        expect(isRecord('string')).toBe(false);
        expect(isRecord(42)).toBe(false);
        expect(isRecord([])).toBe(false);
    });
});
