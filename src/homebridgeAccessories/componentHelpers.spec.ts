import { describe, expect, it } from 'vitest';

import { componentHelpers } from './componentHelpers.js';

describe('componentHelpers', () => {
    it('registers a helper for every supported component type', () => {
        expect([...componentHelpers.keys()].sort()).toEqual(['binarySensor', 'light', 'sensor', 'switch']);
    });

    it('maps each component type to a function helper', () => {
        for (const helper of componentHelpers.values()) {
            expect(typeof helper).toBe('function');
            expect(helper.length).toBeGreaterThanOrEqual(3);
        }
    });

    it('contains no duplicated helpers', () => {
        expect(new Set(componentHelpers.values()).size).toBe(componentHelpers.size);
    });
});
