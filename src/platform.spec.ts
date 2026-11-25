import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { EMPTY, of } from 'rxjs';

import { EsphomePlatform } from './platform.js';
import type { AccessoryRegistry, AccessoryRegistryDeps } from './accessoryRegistry.js';
import type { DeviceSession, DeviceSessionDeps, DeviceTransportConfig } from './deviceSession.js';
import { createFakeDeviceSession } from './testing/fakeDeviceSession.js';
import type { FakeDeviceSession } from './testing/fakeDeviceSession.js';
import { FakePlatformAccessory } from './testing/hapFakes.js';

type StartSession = (config: DeviceTransportConfig, deps: DeviceSessionDeps) => DeviceSession;
type CreateRegistry = (deps: AccessoryRegistryDeps) => AccessoryRegistry;

/** mDNS discovery is mocked so the config/discovery merge can be exercised without a socket. */
const discovery = vi.hoisted(() => ({
    discoverDevices: vi.fn(),
}));

vi.mock('./discovery.js', () => ({ discoverDevices: discovery.discoverDevices }));

const createFakeLogging = () => {
    const base = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const log = Object.assign(base, { info, warn, error, debug }) as unknown as Logging;
    return { log, base, info, warn, error, debug };
};

const createFakeApi = () => {
    const callbacks = new Map<string, Array<(...args: unknown[]) => void>>();
    const on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        callbacks.set(event, [...(callbacks.get(event) ?? []), callback]);
    });
    const api = { on } as unknown as API;
    const didFinishLaunching = () => callbacks.get('didFinishLaunching')?.forEach((callback) => callback());
    const shutdown = () => callbacks.get('shutdown')?.forEach((callback) => callback());
    return { api, on, didFinishLaunching, shutdown };
};

interface FakeRegistry extends AccessoryRegistry {
    readonly restore: Mock;
    readonly bind: Mock;
    readonly stop: Mock;
}

const createFakeRegistry = (): FakeRegistry => ({ restore: vi.fn(), bind: vi.fn(), stop: vi.fn() });

interface SessionCall {
    readonly config: DeviceTransportConfig;
    readonly deps: DeviceSessionDeps;
}

interface PlatformSetupOptions {
    devices?: unknown[];
    blacklist?: unknown;
    debug?: boolean;
    discover?: boolean;
    discoveryTimeout?: number;
    retryAfter?: number;
}

const createPlatform = (options: PlatformSetupOptions = {}) => {
    const logging = createFakeLogging();
    const apiSpies = createFakeApi();
    const sessions: FakeDeviceSession[] = [];
    const calls: SessionCall[] = [];
    const startSession = vi.fn((config: DeviceTransportConfig, deps: DeviceSessionDeps): DeviceSession => {
        const fake = createFakeDeviceSession();
        sessions.push(fake);
        calls.push({ config, deps });
        return fake.session;
    });
    const registry = createFakeRegistry();
    let registryDeps: AccessoryRegistryDeps | undefined;
    const createRegistry = vi.fn((deps: AccessoryRegistryDeps): AccessoryRegistry => {
        registryDeps = deps;
        return registry;
    });
    const config = {
        blacklist: [],
        ...options,
    } as unknown as PlatformConfig;
    const platform = new EsphomePlatform(
        logging.log,
        config,
        apiSpies.api,
        startSession as unknown as StartSession,
        createRegistry as unknown as CreateRegistry,
    );
    return {
        platform,
        config,
        startSession,
        calls,
        sessions,
        registry,
        createRegistry,
        registryDeps: () => registryDeps,
        ...logging,
        ...apiSpies,
    };
};

beforeEach(() => {
    discovery.discoverDevices.mockReset();
});

describe('EsphomePlatform', () => {
    it('logs "starting esphome" and registers the lifecycle callbacks via api.on', () => {
        const { base, on } = createPlatform();

        expect(base).toHaveBeenCalledWith('starting esphome');
        expect(on).toHaveBeenCalledWith('didFinishLaunching', expect.anything());
        expect(on).toHaveBeenCalledWith('shutdown', expect.anything());
    });

    it('logs an error and empties the devices array when neither devices nor discovery are configured', () => {
        const { config, error } = createPlatform();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not specify a devices array'));
        expect((config as { devices?: unknown[] }).devices).toEqual([]);
    });

    it('warns and ignores a non-array blacklist', () => {
        const { warn, registryDeps } = createPlatform({ blacklist: 42 });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"blacklist" configuration must be an array'));
        expect(registryDeps()?.blacklist.size).toBe(0);
    });

    it('passes only the string entries of the blacklist to the registry', () => {
        const { registryDeps } = createPlatform({ blacklist: ['office-light', 42, 'office-fan'] });

        const deps = registryDeps();
        expect(deps?.blacklist.has('office-light')).toBe(true);
        expect(deps?.blacklist.has('office-fan')).toBe(true);
        expect(deps?.blacklist.size).toBe(2);
    });

    it('constructs the registry with the api, log, blacklist, and debug flag', () => {
        const { log, api, registryDeps } = createPlatform({ debug: true });

        const deps = registryDeps();
        expect(deps?.api).toBe(api);
        expect(deps?.log).toBe(log);
        expect(deps?.debug).toBe(true);
    });

    it('starts one session per resolved Device, passing the transport config and log', () => {
        const { didFinishLaunching, calls, startSession } = createPlatform({
            devices: [
                { host: 'esp-one.local', password: 'secret', port: 6053, encryptionKey: 'key', retryAfter: 2000 },
            ],
        });

        didFinishLaunching();

        expect(startSession).toHaveBeenCalledTimes(1);
        expect(calls[0]?.config).toMatchObject({
            host: 'esp-one.local',
            password: 'secret',
            port: 6053,
            encryptionKey: 'key',
            retryAfter: 2000,
            invertFanDirection: false,
        });
        expect(calls[0]?.deps.log).toBeDefined();
    });

    it('passes a debug writer only when debug is enabled', () => {
        const withDebug = createPlatform({ devices: [{ host: 'esp-one.local' }], debug: true });
        withDebug.didFinishLaunching();
        expect(typeof withDebug.calls[0]?.deps.writeDebugDump).toBe('function');

        const withoutDebug = createPlatform({ devices: [{ host: 'esp-one.local' }] });
        withoutDebug.didFinishLaunching();
        expect(withoutDebug.calls[0]?.deps.writeDebugDump).toBeUndefined();
    });

    it('merges a discovered Device with its configured entry and uses the resolved address', () => {
        discovery.discoverDevices.mockReturnValue(of({ host: 'esp-one.local', address: '10.0.0.5' }));
        const { didFinishLaunching, calls } = createPlatform({
            discover: true,
            devices: [{ host: 'esp-one.local', encryptionKey: 'key' }],
        });

        didFinishLaunching();

        expect(calls[0]?.config).toMatchObject({ host: '10.0.0.5', encryptionKey: 'key' });
        expect(discovery.discoverDevices).toHaveBeenCalledWith(5_000, expect.anything());
    });

    it('binds a discovered Device that has no configured entry', () => {
        discovery.discoverDevices.mockReturnValue(of({ host: 'esp-one.local', address: '10.0.0.9' }));
        const { didFinishLaunching, calls } = createPlatform({ discover: true, devices: [] });

        didFinishLaunching();

        expect(calls[0]?.config).toMatchObject({
            host: '10.0.0.9',
            retryAfter: 90000,
            invertFanDirection: false,
        });
    });

    it('binds a configured Device that discovery did not find', () => {
        discovery.discoverDevices.mockReturnValue(EMPTY);
        const { didFinishLaunching, calls } = createPlatform({
            discover: true,
            devices: [{ host: 'conf.local', port: 7000 }],
        });

        didFinishLaunching();

        expect(calls[0]?.config).toMatchObject({ host: 'conf.local', port: 7000 });
    });

    it('starts Discovery with the configured timeout', () => {
        discovery.discoverDevices.mockReturnValue(EMPTY);
        createPlatform({ discover: true, discoveryTimeout: 1234 }).didFinishLaunching();

        expect(discovery.discoverDevices).toHaveBeenCalledWith(1234, expect.anything());
    });

    it('hands the resolved Device config and its session to the registry', () => {
        const { didFinishLaunching, registry, sessions, calls } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });

        didFinishLaunching();

        expect(registry.bind).toHaveBeenCalledTimes(1);
        expect(registry.bind.mock.calls[0]?.[0]).toMatchObject({ host: 'esp-one.local' });
        expect(registry.bind.mock.calls[0]?.[1]).toBe(sessions[0]?.session);
        expect(calls).toHaveLength(1);
    });

    it('delegates cached Accessories to the registry', () => {
        const { platform, registry } = createPlatform();
        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');

        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(registry.restore).toHaveBeenCalledWith(cached);
    });

    it('stops every session and the registry on shutdown', () => {
        const { didFinishLaunching, sessions, registry, shutdown } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        shutdown();

        expect(sessions[0]?.stopCount()).toBe(1);
        expect(sessions[1]?.stopCount()).toBe(1);
        expect(registry.stop).toHaveBeenCalledTimes(1);
    });
});
