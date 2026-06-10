import type { PlatformConfig } from 'homebridge';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DISCOVERY_TIMEOUT, DEFAULT_RETRY_AFTER, PlatformOptions } from './config';

describe('PlatformOptions', () => {
    it('should use default values for minimal config', () => {
        const config: PlatformConfig = { platform: 'esphome' };
        const options = new PlatformOptions(config);

        expect(options.devices).toEqual([]);
        expect(options.blacklist).toEqual([]);
        expect(options.debug).toBe(false);
        expect(options.discover).toBe(false);
        expect(options.discoveryTimeout).toBe(DEFAULT_DISCOVERY_TIMEOUT);
        expect(options.retryAfter).toBe(DEFAULT_RETRY_AFTER);
    });

    it('should parse device and platform options', () => {
        const config: PlatformConfig = {
            platform: 'esphome',
            devices: [
                {
                    host: 'esp.local',
                    port: 6053,
                    password: 'secret',
                    retryAfter: 120_000,
                },
            ],
            blacklist: ['Excluded Switch'],
            debug: true,
            discover: true,
            discoveryTimeout: 10_000,
            retryAfter: 60_000,
        };
        const options = new PlatformOptions(config);

        expect(options.devices).toHaveLength(1);
        expect(options.devices[0]).toEqual({
            host: 'esp.local',
            port: 6053,
            password: 'secret',
            retryAfter: 120_000,
        });
        expect(options.blacklist).toEqual(['Excluded Switch']);
        expect(options.debug).toBe(true);
        expect(options.discover).toBe(true);
        expect(options.discoveryTimeout).toBe(10_000);
        expect(options.retryAfter).toBe(60_000);
    });
});
