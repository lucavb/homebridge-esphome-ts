import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BehaviorSubject, EMPTY, of, Subject } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';

import { EsphomePlatform } from './platform.js';
import type { DeviceSession, DeviceSessionDeps, DeviceTransportConfig } from './deviceSession.js';

type StartSession = (config: DeviceTransportConfig, deps: DeviceSessionDeps) => DeviceSession;
import { asComponent } from './testing/fakeEspDevice.js';
import { makeFakeCharacteristicClass, makeFakeServiceClass, type FakeHapService } from './testing/hapFakes.js';

/** Cross-scope registry shared with the vi.mock factories (hoisted above imports). */
const registry = vi.hoisted(() => ({
    /** component-type -> component helper; absent type => `get` yields undefined. */
    helperMap: new Map<string, unknown>(),
}));

/** mDNS discovery is mocked so the config/discovery merge can be exercised without a socket. */
const discovery = vi.hoisted(() => ({
    discoverDevices: vi.fn(),
}));

vi.mock('./homebridgeAccessories/componentHelpers.js', () => ({
    componentHelpers: {
        get: (type: unknown) => registry.helperMap.get(type as string),
    },
}));

vi.mock('./discovery.js', () => ({ discoverDevices: discovery.discoverDevices }));

const setupComponentHelper = (type: string, helper: Mock) => {
    registry.helperMap.set(type, helper);
};

const StatusActiveCharacteristic = makeFakeCharacteristicClass('status-active-uuid');
const AccessoryInformationService = makeFakeServiceClass('accessory-information-uuid');
const SensorService = makeFakeServiceClass('sensor-service-uuid');

class FakePlatformAccessory {
    public readonly displayName: string;
    public readonly UUID: string;
    public readonly services: FakeHapService[] = [];
    /** Mirrors the real accessory context bag: an untyped record persisted to disk. */
    public readonly context: Record<string, unknown> = {};

    public constructor(displayName: string, uuid: string) {
        this.displayName = displayName;
        this.UUID = uuid;
    }

    public addService(service: FakeHapService): FakeHapService {
        this.services.push(service);
        return service;
    }
}

interface FakeSession extends DeviceSession {
    readonly components$: Subject<ReadonlyArray<BaseComponent>>;
    readonly alive$: BehaviorSubject<boolean>;
    readonly stop: Mock;
    emitComponents(components: ReadonlyArray<BaseComponent>): void;
    emitAlive(alive: boolean): void;
}

const createFakeSession = (): FakeSession => {
    const components$ = new Subject<ReadonlyArray<BaseComponent>>();
    const alive$ = new BehaviorSubject<boolean>(false);
    return {
        components$,
        alive$,
        stop: vi.fn(),
        emitComponents: (components) => components$.next(components),
        emitAlive: (alive) => alive$.next(alive),
    };
};

interface SessionCall {
    readonly config: Record<string, unknown>;
    readonly deps: Record<string, unknown>;
}

interface PrivatePlatformState {
    accessories: FakePlatformAccessory[];
    accessoriesByHost: Map<string, FakePlatformAccessory[]>;
    aliveStateByHost: Map<string, boolean>;
    blacklistSet: Set<string>;
    config: { devices?: unknown[] };
}

const internals = (platform: EsphomePlatform): PrivatePlatformState => platform as unknown as PrivatePlatformState;

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
    const registerPlatformAccessories = vi.fn();
    const unregisterPlatformAccessories = vi.fn();
    const api = {
        on,
        hap: {
            uuid: { generate: (name: string) => `uuid-${name}` },
            Service: { AccessoryInformation: AccessoryInformationService },
            Characteristic: { StatusActive: StatusActiveCharacteristic },
        },
        platformAccessory: FakePlatformAccessory,
        registerPlatformAccessories,
        unregisterPlatformAccessories,
    } as unknown as API;
    const didFinishLaunching = () => callbacks.get('didFinishLaunching')?.forEach((callback) => callback());
    const shutdown = () => callbacks.get('shutdown')?.forEach((callback) => callback());
    return { api, on, registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching, shutdown };
};

interface PlatformSetupOptions {
    devices?: unknown[];
    blacklist?: string[];
    debug?: boolean;
    discover?: boolean;
    retryAfter?: number;
}

const createPlatform = (options: PlatformSetupOptions = {}) => {
    const logSpies = createFakeLogging();
    const apiSpies = createFakeApi();
    const sessions: FakeSession[] = [];
    const calls: SessionCall[] = [];
    const startSession = vi.fn((config: Record<string, unknown>, deps: Record<string, unknown>): FakeSession => {
        const session = createFakeSession();
        sessions.push(session);
        calls.push({ config, deps });
        return session;
    });
    const config = {
        blacklist: [],
        ...options,
    } as unknown as PlatformConfig;
    const platform = new EsphomePlatform(logSpies.log, config, apiSpies.api, startSession as unknown as StartSession);
    return { platform, config, startSession, sessions, calls, ...logSpies, ...apiSpies };
};

const registeredAccessory = (registerPlatformAccessories: Mock): FakePlatformAccessory =>
    registerPlatformAccessories.mock.calls[0]?.[2]?.[0] as FakePlatformAccessory;

const light = () => asComponent({ name: 'office-light', type: 'light' });

beforeEach(() => {
    registry.helperMap.clear();
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
        const { platform, error } = createPlatform();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not specify a devices array'));
        expect(internals(platform).config.devices).toEqual([]);
    });

    it('warns and ignores a non-array blacklist', () => {
        const { platform, warn } = createPlatform({ blacklist: 42 as unknown as string[] });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"blacklist" configuration must be an array'));
        expect(internals(platform).blacklistSet.size).toBe(0);
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

    it('registers an Accessory from discovered Components and persists the host on it', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { didFinishLaunching, sessions, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const component = light();

        sessions[0]?.emitComponents([component]);

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const accessory = registeredAccessory(registerPlatformAccessories);
        expect(accessory.UUID).toBe('uuid-office-light');
        expect(accessory.context.host).toBe('esp-one.local');
        expect(helper).toHaveBeenCalledWith(component, accessory, expect.anything(), {
            invertFanDirection: false,
        });
    });

    it('skips blacklisted Components without calling the helper', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { didFinishLaunching, sessions, registerPlatformAccessories, unregisterPlatformAccessories } =
            createPlatform({
                devices: [{ host: 'esp-one.local' }],
                blacklist: ['office-light'],
            });
        didFinishLaunching();

        sessions[0]?.emitComponents([light()]);

        expect(helper).not.toHaveBeenCalled();
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('logs "not supported" for unknown Component types without registering', () => {
        const { didFinishLaunching, sessions, base, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        didFinishLaunching();

        sessions[0]?.emitComponents([asComponent({ name: 'roomba', type: 'vacuum' })]);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('currently not supported'));
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('does not register a brand-new Accessory when the helper yields no teardown', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { didFinishLaunching, sessions, base, registerPlatformAccessories, unregisterPlatformAccessories } =
            createPlatform({ devices: [{ host: 'esp-one.local' }] });
        didFinishLaunching();

        sessions[0]?.emitComponents([light()]);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('could not be mapped'));
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('unregisters a pre-existing Accessory when the helper yields no teardown', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { platform, didFinishLaunching, sessions, unregisterPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const existing = new FakePlatformAccessory('office-light', 'uuid-office-light');
        platform.configureAccessory(existing as unknown as PlatformAccessory);
        didFinishLaunching();

        sessions[0]?.emitComponents([light()]);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0]?.[2]?.[0]).toBe(existing);
        expect(internals(platform).accessories).toHaveLength(1);
    });

    it('passes invertFanDirection to the component helper', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('fan', helper);
        const { didFinishLaunching, sessions } = createPlatform({
            devices: [{ host: 'esp-one.local', invertFanDirection: true }],
        });
        didFinishLaunching();

        sessions[0]?.emitComponents([asComponent({ name: 'office-fan', type: 'fan' })]);

        expect(helper).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'office-fan' }),
            expect.anything(),
            expect.anything(),
            { invertFanDirection: true },
        );
    });

    it('continues setting up other Devices when a component helper throws', () => {
        const successfulHelper = vi.fn(() => () => {});
        setupComponentHelper(
            'broken-light',
            vi.fn(() => {
                throw new Error('component setup failed');
            }),
        );
        setupComponentHelper('light', successfulHelper);
        const { didFinishLaunching, sessions, error, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        sessions[0]?.emitComponents([asComponent({ name: 'broken-component', type: 'broken-light' })]);
        sessions[1]?.emitComponents([light()]);

        expect(successfulHelper).toHaveBeenCalledTimes(1);
        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Error while discovering or setting up accessories'),
            expect.any(Error),
        );
    });

    it('syncs the last known connection state into freshly added Accessories', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { didFinishLaunching, sessions, registerPlatformAccessories } = createPlatform({
            // Two configured entries for the same host run addAccessories twice for it.
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();

        sessions[0]?.emitComponents([light()]);
        const accessory = registeredAccessory(registerPlatformAccessories);
        const sensorService = new SensorService();
        accessory.addService(sensorService);

        sessions[0]?.emitAlive(false);
        sessions[1]?.emitComponents([light()]);

        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(false);

        sessions[1]?.emitAlive(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('re-associates cached Accessories with their persisted host for status sync', () => {
        const { platform, didFinishLaunching, sessions, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
        const sensorService = new SensorService();
        cached.addService(sensorService);
        cached.context.host = 'esp-one.local';
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(internals(platform).accessories).toHaveLength(1);
        expect(registerPlatformAccessories).not.toHaveBeenCalled();

        didFinishLaunching();
        sessions[0]?.emitAlive(true);

        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('associates nothing for cached Accessories from older disk caches without context.host', () => {
        const { platform, didFinishLaunching, sessions } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const cached = new FakePlatformAccessory('old-cached-component', 'uuid-old-cached');
        const sensorService = new SensorService();
        cached.addService(sensorService);
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        didFinishLaunching();
        sessions[0]?.emitAlive(true);

        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);
    });

    it('unregisters blacklisted cached Accessories', () => {
        const { platform, unregisterPlatformAccessories } = createPlatform({ blacklist: ['forbidden'] });
        const cached = new FakePlatformAccessory('forbidden', 'uuid-forbidden');
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0]?.[2]?.[0]).toBe(cached);
        expect(internals(platform).accessories).toHaveLength(0);
    });

    it('guards against duplicate associations for the same host and Component', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { platform, didFinishLaunching, sessions, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();

        sessions[0]?.emitComponents([light()]);
        sessions[1]?.emitComponents([light()]);

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const state = internals(platform);
        expect(state.accessories).toHaveLength(1);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(1);

        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
        cached.context.host = 'esp-one.local';
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        expect(state.accessories).toHaveLength(2);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(2);
    });

    it('stops every session and drops later emissions on shutdown', () => {
        const { didFinishLaunching, sessions, shutdown, registerPlatformAccessories } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        shutdown();

        expect(sessions[0]?.stop).toHaveBeenCalledTimes(1);
        expect(sessions[1]?.stop).toHaveBeenCalledTimes(1);

        sessions[0]?.emitComponents([light()]);
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
    });
});
