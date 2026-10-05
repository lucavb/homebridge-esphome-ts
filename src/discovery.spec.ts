import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logging } from 'homebridge';

import { discoverDevices } from './discovery.js';

const mockState = {
    options: undefined as unknown,
    initializeDeviceCallback: undefined as ((service: unknown) => void) | undefined,
    browser: { stopped: false },
};

vi.mock('bonjour-hap', () => {
    class FakeBrowser {
        public stopped = false;
        public stop(): void {
            this.stopped = true;
        }
    }

    class FakeBonjour {
        public find(options: unknown, initializeDeviceCallback: (service: unknown) => void): { stop: () => void } {
            mockState.options = options;
            mockState.initializeDeviceCallback = initializeDeviceCallback;
            const browser = new FakeBrowser();
            mockState.browser = browser;
            return browser;
        }
    }

    return { default: FakeBonjour };
});

const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
} as unknown as Logging;

const mdnsBaseRecord = {
    name: 'esp-device',
    fqdn: 'unnamed._esphomelib._tcp.local.',
    host: 'esp-device.local:0/0',
    referer: { address: '192.168.1.50', family: 'IPv4', port: 6053 },
    port: 6053,
    type: 'esphomelib',
    protocol: 'tcp',
    addresses: ['169.254.10.2', '192.168.1.50'],
    txt: {},
};

describe('discoverDevices', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('registers DNS-SD discovery for the esphomelib mDNS type', () => {
        discoverDevices(1_000, log).subscribe();
        expect(mockState.options).toEqual({ type: 'esphomelib' });
    });

    it('maps mDNS records to device configs and excludes link-local IPv4 and the default port', () => {
        const next = vi.fn();
        const complete = vi.fn();
        discoverDevices(1_000, log).subscribe({ next, complete });

        mockState.initializeDeviceCallback!({
            ...mdnsBaseRecord,
            addresses: ['169.254.10.2', '192.168.1.50'],
            port: 6053,
        });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: undefined, address: '192.168.1.50' });
        expect(log.info).toHaveBeenCalledWith('HAP Device discovered', 'esp-device');
    });

    it('passes through non-default ports and prefers IPv6 addresses over excluded link-local IPv4', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        mockState.initializeDeviceCallback!({
            ...mdnsBaseRecord,
            addresses: ['169.254.10.2', 'fd00::dead:beef'],
            port: 5555,
        });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: 5555, address: 'fd00::dead:beef' });
    });

    it('yields no address when no acceptable address exists', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        mockState.initializeDeviceCallback!({ ...mdnsBaseRecord, addresses: ['169.254.10.2'] });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: undefined, address: undefined });
    });

    it('emits every discovered device', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        mockState.initializeDeviceCallback!({ ...mdnsBaseRecord, name: 'esp-one' });
        mockState.initializeDeviceCallback!({ ...mdnsBaseRecord, name: 'esp-two' });

        expect(next).toHaveBeenCalledTimes(2);
    });

    it('stops the browser after the timeout and completes the observable', () => {
        const next = vi.fn();
        const complete = vi.fn();
        discoverDevices(1_000, log).subscribe({ next, complete });

        expect(mockState.browser.stopped).toBe(false);
        vi.advanceTimersByTime(1_000);

        expect(mockState.browser.stopped).toBe(true);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(next).not.toHaveBeenCalled();
    });
});
