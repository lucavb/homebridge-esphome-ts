import type { Logging } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { toArray } from 'rxjs/operators';

const mockFind = vi.fn();

vi.mock('bonjour-hap', () => ({
    default: class MockBonjour {
        find(_options: unknown, callback: (service: unknown) => void) {
            mockFind(_options, callback);
            return { stop: vi.fn() };
        }
    },
}));

import { discoverDevices } from './discovery';

describe('discoverDevices', () => {
    const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    } as unknown as Logging;

    beforeEach(() => {
        vi.useFakeTimers();
        mockFind.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('maps discovered services to device config', async () => {
        mockFind.mockImplementation((_options, callback) => {
            callback({
                name: 'Living Room ESP',
                host: 'living-room.local',
                addresses: ['192.168.1.50'],
                port: 6053,
            });
        });

        const resultPromise = firstValueFrom(discoverDevices(100, log).pipe(toArray()));
        vi.advanceTimersByTime(100);
        const results = await resultPromise;

        expect(results).toEqual([
            {
                host: 'living-room.local',
                port: undefined,
                address: '192.168.1.50',
            },
        ]);
        expect(log.info).toHaveBeenCalledWith('HAP Device discovered', 'Living Room ESP');
    });

    it('includes non-default ports in the result', async () => {
        mockFind.mockImplementation((_options, callback) => {
            callback({
                name: 'Custom Port ESP',
                host: 'custom.local',
                addresses: ['10.0.0.5'],
                port: 9001,
            });
        });

        const resultPromise = firstValueFrom(discoverDevices(50, log).pipe(toArray()));
        vi.advanceTimersByTime(50);
        const results = await resultPromise;

        expect(results[0]?.port).toBe(9001);
    });
});
