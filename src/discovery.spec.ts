import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logging } from 'homebridge';
import { ok } from 'node:assert/strict';

import { discoverDevices } from './discovery.js';

const mockState = {
    options: undefined as unknown,
    initializeDeviceCallback: undefined as ((service: unknown) => void) | undefined,
    browser: { stopped: false },
    destroy: vi.fn(),
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

        public destroy(): void {
            mockState.destroy();
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

    /** Dispatches one mDNS "service up" event, failing loudly if the browser never registered its callback. */
    const emitDiscoveredService = (record: Record<string, unknown>): void => {
        ok(mockState.initializeDeviceCallback, 'expected the bonjour find callback to be registered');
        mockState.initializeDeviceCallback({
            ...mdnsBaseRecord,
            ...record,
        });
    };

    it('registers DNS-SD discovery for the esphomelib mDNS type', () => {
        discoverDevices(1_000, log).subscribe();
        expect(mockState.options).toEqual({ type: 'esphomelib' });
    });

    it('maps mDNS records to device configs and excludes link-local IPv4 and the default port', () => {
        const next = vi.fn();
        const complete = vi.fn();
        discoverDevices(1_000, log).subscribe({ next, complete });

        emitDiscoveredService({
            addresses: ['169.254.10.2', '192.168.1.50'],
            port: 6053,
        });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: undefined, address: '192.168.1.50' });
        expect(log.info).toHaveBeenCalledWith('HAP Device discovered', 'esp-device');
    });

    it('passes through non-default ports and prefers IPv6 addresses over excluded link-local IPv4', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        emitDiscoveredService({
            addresses: ['169.254.10.2', 'fd00::dead:beef'],
            port: 5555,
        });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: 5555, address: 'fd00::dead:beef' });
    });

    it('yields no address when no acceptable address exists', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        emitDiscoveredService({ addresses: ['169.254.10.2'] });

        expect(next).toHaveBeenCalledWith({ host: 'esp-device.local:0/0', port: undefined, address: undefined });
    });

    it('emits every discovered device', () => {
        const next = vi.fn();
        discoverDevices(1_000, log).subscribe({ next });

        emitDiscoveredService({ name: 'esp-one' });
        emitDiscoveredService({ name: 'esp-two' });

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

    it('stops the browser and destroys the bonjour instance on early unsubscribe, dropping late events', () => {
        const next = vi.fn();
        const complete = vi.fn();
        const subscription = discoverDevices(1_000, log).subscribe({ next, complete });

        emitDiscoveredService({ name: 'esp-early' });
        subscription.unsubscribe();

        expect(mockState.browser.stopped).toBe(true);
        expect(mockState.destroy).toHaveBeenCalledTimes(1);

        emitDiscoveredService({ name: 'esp-late' });
        expect(next).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1_000);
        expect(next).toHaveBeenCalledTimes(1);
        expect(complete).not.toHaveBeenCalled();
    });
});
