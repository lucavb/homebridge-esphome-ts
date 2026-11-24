import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BehaviorSubject, EMPTY, of, Subject, Subscription, type Observable } from 'rxjs';
// The classes below are the *mocked* esphome-ts exports from the vi.mock factory;
// importing them via the same specifier hands back the mock classes for instanceof-friendly
// emission.
import {
    ConnectionHandshakeError,
    EncryptionHandshakeError,
    EncryptionPlaintextError,
    EncryptionRequiredError,
    EspDevice,
    InvalidEncryptionKeyError,
    InvalidPasswordError,
} from 'esphome-ts';
import { EsphomePlatform } from './platform.js';
import { makeFakeCharacteristicClass, makeFakeServiceClass, type FakeHapService } from './testing/hapFakes.js';

/**
 * Cross-scope registry shared with the vi.mock factories (vi.mock factories are hoisted above
 * imports, so their factories may only reach variables defined via vi.hoisted).
 */
const registry = vi.hoisted(() => ({
    espDevices: [] as unknown[],
    /** component-type -> component helper; absent type => `get` yields undefined. */
    helperMap: new Map<string, unknown>(),
}));

/** The debug dump writer is mocked so the platform's ownership and failure wiring can be asserted. */
const debugWriter = vi.hoisted(() => ({
    writeReadDataToLogFile: vi.fn(),
}));

/** mDNS discovery is mocked so the config/discovery merge can be exercised without a socket. */
const discovery = vi.hoisted(() => ({
    discoverDevices: vi.fn(),
}));

vi.mock('esphome-ts', () => {
    class MockEncryptionError extends Error {}

    class MockInvalidPasswordError extends Error {}

    class MockInvalidEncryptionKeyError extends MockEncryptionError {
        public constructor(
            public readonly serverName?: string,
            public readonly serverMac?: string,
        ) {
            super('the device rejected the encryption key');
        }
    }

    class MockEncryptionRequiredError extends MockEncryptionError {}

    class MockEncryptionPlaintextError extends MockEncryptionError {}

    class MockEncryptionHandshakeError extends MockEncryptionError {}

    class MockConnectionHandshakeError extends Error {}

    class MockInvalidEncryptionKeyFormatError extends MockEncryptionError {
        public constructor(message = 'encryptionKey must be a base64-encoded 32-byte value') {
            super(message);
        }
    }

    const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/=\s]+$/;

    class MockEspDevice {
        public readonly error$ = new Subject<Error>();
        public readonly discovery$ = new BehaviorSubject<boolean>(false);
        // Faithful to esphome-ts v5: alive$ merges socket.connected$ (a BehaviorSubject(false))
        // through distinctUntilChanged + shareReplay({ bufferSize: 1, refCount: true }), so every
        // subscriber synchronously receives the buffered false at subscribe time.
        public readonly alive$ = new BehaviorSubject<boolean>(false);
        public readonly components: Record<string, { name: string; type: string }> = {};
        public readonly provideRetryObservable = vi.fn();
        public readonly terminate = vi.fn();

        public constructor(
            public readonly host: string,
            public readonly password?: string,
            public readonly port?: number,
            public readonly options?: { encryptionKey?: string },
        ) {
            if (options?.encryptionKey !== undefined) {
                // Model the installed 5.2.1 EspSocket: trim, treat a blank key as no key, then
                // base64 charset, exact 32-byte length, and rejection of the all-zero sentinel.
                const trimmed = options.encryptionKey.trim();
                if (trimmed !== '') {
                    if (!BASE64_KEY_PATTERN.test(trimmed)) {
                        throw new MockInvalidEncryptionKeyFormatError();
                    }
                    const decoded = Buffer.from(trimmed, 'base64');
                    if (decoded.length !== 32) {
                        throw new MockInvalidEncryptionKeyFormatError();
                    }
                    if (decoded.every((byte) => byte === 0)) {
                        throw new MockInvalidEncryptionKeyFormatError(
                            'encryptionKey must not be the all-zero provisioning sentinel',
                        );
                    }
                }
            }
            registry.espDevices.push(this);
        }
    }

    return {
        EspDevice: MockEspDevice,
        InvalidPasswordError: MockInvalidPasswordError,
        InvalidEncryptionKeyError: MockInvalidEncryptionKeyError,
        EncryptionRequiredError: MockEncryptionRequiredError,
        EncryptionPlaintextError: MockEncryptionPlaintextError,
        EncryptionHandshakeError: MockEncryptionHandshakeError,
        ConnectionHandshakeError: MockConnectionHandshakeError,
        InvalidEncryptionKeyFormatError: MockInvalidEncryptionKeyFormatError,
    };
});

// The registry mock exposes only `get`, mirroring the `componentHelpers.get(component.type)`
// call the platform makes. A mapped component is registered as a *function* — truthy under the
// older boolean-registry contract AND a teardown-producing helper under the current contract,
// keeping the spec honest under both. An unmapped component is simply absent from the map, so
// `get` returns undefined. A helper whose *invocation* returns undefined produces the
// "could not be mapped" branch; one returning a teardown produces the success path.
const setupComponentHelper = (type: string, helper: Mock) => {
    registry.helperMap.set(type, helper);
};

vi.mock('./homebridgeAccessories/componentHelpers.js', () => ({
    componentHelpers: {
        get: (type: unknown) => registry.helperMap.get(type as string),
    },
}));

vi.mock('./shared/index.js', async (importOriginal) => {
    const actual = (await importOriginal()) as object;
    return { ...actual, writeReadDataToLogFile: debugWriter.writeReadDataToLogFile };
});

vi.mock('./discovery.js', () => ({ discoverDevices: discovery.discoverDevices }));

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

interface PrivatePlatformState {
    accessories: FakePlatformAccessory[];
    accessoriesByHost: Map<string, FakePlatformAccessory[]>;
    aliveStateByHost: Map<string, boolean>;
    blacklistSet: Set<string>;
    config: { devices?: unknown[] };
}

const internals = (platform: EsphomePlatform): PrivatePlatformState => platform as unknown as PrivatePlatformState;

/** A throwaway 32-byte base64 Noise PSK for tests (bytes 1..32, not a real device key). */
const VALID_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

/** Shape of the mocked EspDevice instance the platform exercised, as the spec sees it. */
interface MockEspDeviceInstance {
    readonly host: string;
    readonly password: string | undefined;
    readonly port: number | undefined;
    readonly options: { encryptionKey?: string } | undefined;
    readonly error$: { next: (error: Error) => void };
    readonly discovery$: { next: (discovered: boolean) => void };
    readonly alive$: { next: (alive: boolean) => void };
    readonly components: Record<string, { name: string; type: string }>;
    readonly provideRetryObservable: Mock;
    readonly terminate: Mock;
}

const espDeviceAt = (index: number) => registry.espDevices[index] as unknown as MockEspDeviceInstance;

/** Subscribes to the retry cadence the platform passed to the device, recording its ticks. */
const retryEmissions = (index = 0): { emissions: unknown[]; subscription: Subscription } => {
    const retry$ = espDeviceAt(index).provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;
    const emissions: unknown[] = [];
    return { emissions, subscription: retry$.subscribe((value) => emissions.push(value)) };
};

const registeredAccessory = (registerPlatformAccessories: Mock): FakePlatformAccessory =>
    registerPlatformAccessories.mock.calls[0]?.[2]?.[0] as FakePlatformAccessory;

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
    devices?: Array<{
        host: string;
        password?: string;
        port?: number;
        encryptionKey?: string;
        invertFanDirection?: boolean;
        retryAfter?: number;
    }>;
    blacklist?: string[];
    debug?: boolean;
    discover?: boolean;
    retryAfter?: number;
}

const createPlatform = (options: PlatformSetupOptions = {}) => {
    const logSpies = createFakeLogging();
    const apiSpies = createFakeApi();
    const config = {
        blacklist: [],
        ...options,
    } as unknown as PlatformConfig;
    const platform = new EsphomePlatform(logSpies.log, config, apiSpies.api);
    return { platform, config, ...logSpies, ...apiSpies };
};

const addComponent = (device: MockEspDeviceInstance, name: string, type: string): void => {
    device.components[type] = { name, type };
};

beforeEach(() => {
    registry.espDevices.length = 0;
    registry.helperMap.clear();
    debugWriter.writeReadDataToLogFile.mockReset();
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

    it('constructs an EspDevice from config and persists the host on a mapped component accessory', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret', port: 6053 }],
        });
        didFinishLaunching();

        expect(registry.espDevices).toHaveLength(1);
        const device = espDeviceAt(0);
        expect(device.host).toBe('esp-one.local');
        expect(device.password).toBe('secret');
        expect(device.port).toBe(6053);
        expect(device.provideRetryObservable).toHaveBeenCalledTimes(1);

        addComponent(device, 'office-light', 'light');
        device.discovery$.next(true);

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const accessory = registeredAccessory(registerPlatformAccessories);
        expect(accessory.UUID).toBe('uuid-office-light');
        // H7: host persisted on the accessory so a cached accessory re-associates on restore.
        expect(accessory.context.host).toBe('esp-one.local');
        expect(helper).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'office-light' }),
            accessory,
            expect.anything(),
            expect.anything(),
        );
    });

    it('skips blacklisted components without calling the component helper', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
            blacklist: ['office-light'],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-light', 'light');
        device.discovery$.next(true);

        expect(helper).not.toHaveBeenCalled();
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('logs "not supported" for unknown component types without registering', () => {
        const { base, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'roomba', 'vacuum');
        espDeviceAt(0).discovery$.next(true);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('currently not supported'));
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('does not register a brand-new accessory when the helper yields no teardown', () => {
        // Helper itself truthy, its invocation returns undefined: `() => undefined`.
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { base, registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching } = createPlatform(
            { devices: [{ host: 'esp-one.local' }] },
        );
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'office-light', 'light');
        espDeviceAt(0).discovery$.next(true);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('could not be mapped'));
        // Brand-new accessory: nothing was registered, so nothing may be unregistered either.
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('unregisters a pre-existing accessory when the helper yields no teardown', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { platform, unregisterPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const existing = new FakePlatformAccessory('office-light', 'uuid-office-light');
        platform.configureAccessory(existing as unknown as PlatformAccessory);
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'office-light', 'light');
        espDeviceAt(0).discovery$.next(true);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0][2][0]).toBe(existing);
        expect(internals(platform).accessories).toHaveLength(1); // the cached push, minus nothing new
    });

    it('names the host and password config on InvalidPasswordError and debugs other errors', () => {
        const { error, debug, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret' }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);

        device.error$.next(new InvalidPasswordError('esp-one.local'));
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('rejected your password'));

        device.error$.next(new Error('boom'));
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'), expect.anything());
        expect(error).toHaveBeenCalledTimes(1); // plain errors never go to the error log
    });

    it('stops the retry cadence when the device rejects the password', () => {
        // esphome-ts 5 latches an InvalidPasswordError as terminal, so the retry cadence the
        // platform provides must complete instead of ticking futile reconnect logs forever.
        vi.useFakeTimers();
        try {
            const { info, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', password: 'secret', retryAfter: 1000 }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            const retry$ = device.provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;
            const emissions: unknown[] = [];
            const subscription = retry$.subscribe((value) => emissions.push(value));

            vi.advanceTimersByTime(2000);
            expect(emissions).toHaveLength(2);
            expect(info).toHaveBeenCalledWith(expect.stringContaining('Trying to reconnect'));

            device.error$.next(new InvalidPasswordError('esp-one.local'));
            expect(subscription.closed).toBe(true);

            vi.advanceTimersByTime(5000);
            expect(emissions).toHaveLength(2); // the latch keeps the cadence stopped
        } finally {
            vi.useRealTimers();
        }
    });

    it('replays a terminal failure to a cadence the library resubscribes', () => {
        // The spec simulates the library's cadence contract: esphome-ts subscribes the provided
        // observable only while alive$ is false and tears it down when the device connects, so a
        // terminal error that arrives during a live connection is followed by a FRESH
        // subscription. The notifier must replay the latched error or the new subscription waits
        // forever. (The mock does not model the library; this test pins the platform's replay.)
        const { didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret', retryAfter: 1000 }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        const retry$ = device.provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;

        const connectedCadence = retry$.subscribe();
        connectedCadence.unsubscribe(); // the device connected; the library dropped the cadence
        device.error$.next(new InvalidPasswordError('esp-one.local'));

        const resubscribedCadence = retry$.subscribe();
        expect(resubscribedCadence.closed).toBe(true);
    });

    it('keeps the retry cadence and discovery wait alive after a retryable handshake failure', () => {
        vi.useFakeTimers();
        try {
            const helper = vi.fn(() => () => {});
            setupComponentHelper('light', helper);
            const { didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY, retryAfter: 1000 }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            addComponent(device, 'office-light', 'light');
            const retry$ = device.provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;
            const emissions: unknown[] = [];
            const subscription = retry$.subscribe((value) => emissions.push(value));

            device.error$.next(new EncryptionHandshakeError('bad hello'));
            expect(subscription.closed).toBe(false);

            vi.advanceTimersByTime(1000);
            expect(emissions).toHaveLength(1);

            device.discovery$.next(true);
            expect(helper).toHaveBeenCalledTimes(1);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('passes a trimmed encryptionKey to the device constructor without a blank-key warning', () => {
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: `  ${VALID_KEY}\n` }],
        });
        didFinishLaunching();

        expect(espDeviceAt(0).options).toEqual({ encryptionKey: VALID_KEY });
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is blank'));
    });

    it('omits the options object when the encryptionKey is empty', () => {
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: '' }],
        });
        didFinishLaunching();

        expect(espDeviceAt(0).options).toBeUndefined();
        // An empty field is the normal "unencrypted" state in the config UI: no warning.
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is blank'));
    });

    it('warns and treats a whitespace-only encryptionKey as unset', () => {
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: '   ' }],
        });
        didFinishLaunching();

        expect(espDeviceAt(0).options).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('"encryptionKey" configured for esp-one.local is blank'),
        );
    });

    it('skips a device entry without a usable host and keeps the others', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: '' }, { host: 42 as unknown as string }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('"host"'));
        expect(error).toHaveBeenCalledTimes(2);
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('rejects a non-string password before constructing the device and keeps other devices', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 42 as unknown as string }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('"password" configured for esp-one.local'));
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('owns the debug dump subscription and reports a failed write', () => {
        const dumpSubscription = new Subscription();
        debugWriter.writeReadDataToLogFile.mockReturnValue(dumpSubscription);
        const { warn, debug, didFinishLaunching, shutdown } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
            debug: true,
        });

        didFinishLaunching();

        expect(debugWriter.writeReadDataToLogFile).toHaveBeenCalledWith(
            'esp-one.local',
            expect.anything(),
            expect.any(Function),
        );
        const onWriteError = debugWriter.writeReadDataToLogFile.mock.calls[0]?.[2] as (error: unknown) => void;
        onWriteError(new Error('ENOSPC'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Writing the raw data for esp-one.local'));
        expect(debug).toHaveBeenCalledWith('debug dump write failed', expect.anything());

        expect(dumpSubscription.closed).toBe(false);
        shutdown();
        expect(dumpSubscription.closed).toBe(true);
    });

    it('does not claim a dump when the device exposes no socket', () => {
        debugWriter.writeReadDataToLogFile.mockReturnValue(undefined);
        const { base, debug, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
            debug: true,
        });

        didFinishLaunching();

        expect(base).not.toHaveBeenCalledWith(expect.stringContaining('Writing the raw data'));
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('debug dumps are unavailable'));
    });

    it('skips non-object device entries and keeps the others', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [
                null as unknown as { host: string },
                'not-an-entry' as unknown as { host: string },
                { host: 'esp-two.local' },
            ],
        });

        didFinishLaunching();

        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('devices[0]'));
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('merges a discovered device with its configured entry by hostname and uses the resolved address', () => {
        discovery.discoverDevices.mockReturnValue(of({ host: 'esp-one.local', address: '10.0.0.5' }));
        const { error, didFinishLaunching } = createPlatform({
            discover: true,
            devices: [null as unknown as { host: string }, { host: 'esp-one.local', encryptionKey: VALID_KEY }],
        });

        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('devices[0]'));
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('10.0.0.5');
        expect(espDeviceAt(0).options).toEqual({ encryptionKey: VALID_KEY });
    });

    it('binds a discovered device that has no configured entry', () => {
        discovery.discoverDevices.mockReturnValue(of({ host: 'esp-one.local', address: '10.0.0.9' }));
        const { didFinishLaunching } = createPlatform({ discover: true, devices: [] });

        didFinishLaunching();

        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('10.0.0.9');
        expect(espDeviceAt(0).options).toBeUndefined();
    });

    it('binds a configured device that discovery did not find', () => {
        discovery.discoverDevices.mockReturnValue(EMPTY);
        const { didFinishLaunching } = createPlatform({
            discover: true,
            devices: [{ host: 'conf.local', port: 7000 }],
        });

        didFinishLaunching();

        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('conf.local');
        expect(espDeviceAt(0).port).toBe(7000);
    });

    it('accepts a null password without the both-credentials warning', () => {
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: null as unknown as string, encryptionKey: VALID_KEY }],
        });

        didFinishLaunching();

        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).password).toBeUndefined();
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Both "password"'));
    });

    it('coerces a numeric-string port', () => {
        const { didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', port: '6053' as unknown as number }],
        });

        didFinishLaunching();

        expect(espDeviceAt(0).port).toBe(6053);
    });

    it('rejects an out-of-range port before constructing the device', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', port: 70_000 }],
        });

        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('"port"'));
        expect(registry.espDevices).toHaveLength(0);
    });

    it('rejects a boolean port instead of coercing it to a privileged port', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', port: true as unknown as number }],
        });

        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('"port"'));
        expect(registry.espDevices).toHaveLength(0);
    });

    it('ignores a non-iterable blacklist and starts with an empty set', () => {
        const { warn, platform } = createPlatform({ blacklist: 42 as unknown as string[] });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"blacklist" configuration must be an array'));
        expect(internals(platform).blacklistSet.size).toBe(0);
    });

    it('normalises a non-array devices configuration when discovery is off', () => {
        const { error, platform } = createPlatform({ devices: 'oops' as unknown as { host: string }[] });

        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not specify a devices array'));
        expect(internals(platform).config.devices).toEqual([]);
    });

    it('ignores a non-array devices configuration when discovery is enabled', () => {
        discovery.discoverDevices.mockReturnValue(EMPTY);
        const { error, didFinishLaunching } = createPlatform({
            discover: true,
            devices: 'oops' as unknown as { host: string }[],
        });

        expect(didFinishLaunching).not.toThrow();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"devices" configuration must be an array'));
    });

    it('models the library key constructor for blank, valid and malformed keys', () => {
        expect(() => new EspDevice('esp-one.local', '', undefined, { encryptionKey: '   ' })).not.toThrow();
        expect(() => new EspDevice('esp-one.local', '', undefined, { encryptionKey: VALID_KEY })).not.toThrow();
        expect(() => new EspDevice('esp-one.local', '', undefined, { encryptionKey: 'not-base64!' })).toThrow();
    });

    it('falls back to the default retry delay for an unusable retryAfter', () => {
        vi.useFakeTimers();
        try {
            const { warn, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', retryAfter: 'soon' as unknown as number }],
            });
            didFinishLaunching();
            const { emissions, subscription } = retryEmissions();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('"retryAfter"'));
            vi.advanceTimersByTime(1_000);
            expect(emissions).toHaveLength(0);
            vi.advanceTimersByTime(89_000);
            expect(emissions).toHaveLength(1);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back to the configured global retryAfter when the device value is unusable', () => {
        vi.useFakeTimers();
        try {
            const { didFinishLaunching } = createPlatform({
                retryAfter: 5_000,
                devices: [{ host: 'esp-one.local', retryAfter: 'soon' as unknown as number }],
            });
            didFinishLaunching();
            const { emissions, subscription } = retryEmissions();

            vi.advanceTimersByTime(4_999);
            expect(emissions).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(emissions).toHaveLength(1);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('clamps a sub-second retryAfter to the one-second floor', () => {
        vi.useFakeTimers();
        try {
            const { warn, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', retryAfter: 0.5 }],
            });
            didFinishLaunching();
            const { emissions, subscription } = retryEmissions();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('using 1000 ms'));
            vi.advanceTimersByTime(999);
            expect(emissions).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(emissions).toHaveLength(1);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('accepts a fractional retryAfter that rounds into range without warning', () => {
        vi.useFakeTimers();
        try {
            const { warn, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', retryAfter: 1_000.4 }],
            });
            didFinishLaunching();
            const { emissions, subscription } = retryEmissions();

            expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"retryAfter"'));
            vi.advanceTimersByTime(999);
            expect(emissions).toHaveLength(0);
            vi.advanceTimersByTime(1);
            expect(emissions).toHaveLength(1);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('clamps an oversized retryAfter instead of letting Node fire it at 1 ms', () => {
        vi.useFakeTimers();
        try {
            const { warn, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', retryAfter: 3_000_000_000 }],
            });
            didFinishLaunching();
            const { emissions, subscription } = retryEmissions();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('using 2147483647 ms'));
            vi.advanceTimersByTime(1_000);
            expect(emissions).toHaveLength(0);

            subscription.unsubscribe();
        } finally {
            vi.useRealTimers();
        }
    });

    it('treats a null encryptionKey as unset', () => {
        const { didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: null as unknown as string }],
        });
        didFinishLaunching();

        expect(espDeviceAt(0).options).toBeUndefined();
    });

    it('rejects a non-string encryptionKey before constructing the device and keeps other devices', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: 42 as unknown as string }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('must be a string'));
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('contains a wrong-length encryptionKey constructor throw and still sets up other devices', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [
                { host: 'esp-one.local', encryptionKey: Buffer.alloc(31).toString('base64') },
                { host: 'esp-two.local' },
            ],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('32-byte'), expect.anything());
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('contains a non-base64 encryptionKey constructor throw and still sets up other devices', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: '!'.repeat(44) }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('32-byte'), expect.anything());
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('contains an invalid encryptionKey constructor throw and still sets up other devices', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [
                { host: 'esp-one.local', encryptionKey: Buffer.alloc(32).toString('base64') },
                { host: 'esp-two.local' },
            ],
        });
        didFinishLaunching();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('all-zero'), expect.anything());
        expect(registry.espDevices).toHaveLength(1);
        expect(espDeviceAt(0).host).toBe('esp-two.local');
    });

    it('warns when both password and encryptionKey are configured', () => {
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret', encryptionKey: VALID_KEY }],
        });
        didFinishLaunching();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Both "password" and "encryptionKey"'));
        expect(espDeviceAt(0).options).toEqual({ encryptionKey: VALID_KEY });
    });

    it('warns and ignores a non-boolean invertFanDirection', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('fan', helper);
        const { warn, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', invertFanDirection: 'true' as unknown as boolean }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-fan', 'fan');
        device.discovery$.next(true);

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"invertFanDirection"'));
        expect(helper).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'office-fan' }),
            expect.anything(),
            expect.anything(),
            { invertFanDirection: false },
        );
    });

    it.each([
        [
            'InvalidEncryptionKeyError',
            () => new InvalidEncryptionKeyError('Kitchen fan', 'AA:BB:CC:DD:EE:FF'),
            'rejected your encryption key',
        ],
        ['EncryptionRequiredError', () => new EncryptionRequiredError(), 'requires API encryption'],
        ['EncryptionPlaintextError', () => new EncryptionPlaintextError(), 'not using API encryption'],
    ])('stops the retry cadence and logs actionable text on terminal %s', (_, makeError, expectedText) => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY, retryAfter: 1000 }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        const retry$ = device.provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;
        const subscription = retry$.subscribe();

        device.error$.next(makeError());

        expect(subscription.closed).toBe(true);
        expect(error).toHaveBeenCalledWith(expect.stringContaining(expectedText));
    });

    it('names the reported device on a rejected encryption key', () => {
        const { error, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY }],
        });
        didFinishLaunching();

        espDeviceAt(0).error$.next(new InvalidEncryptionKeyError('Kitchen fan', 'AA:BB:CC:DD:EE:FF'));

        expect(error).toHaveBeenCalledWith(expect.stringContaining('Kitchen fan'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('AA:BB:CC:DD:EE:FF'));
    });

    it('warns once per retryable handshake kind and then drops to debug', () => {
        const { warn, debug, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);

        device.error$.next(new EncryptionHandshakeError('bad hello'));
        device.error$.next(new ConnectionHandshakeError('closed'));
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'));

        device.error$.next(new EncryptionHandshakeError('bad hello again'));
        device.error$.next(new ConnectionHandshakeError('closed again'));
        expect(warn).toHaveBeenCalledTimes(2); // each kind is warned only once
        expect(debug).toHaveBeenCalledTimes(2);
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'), expect.anything());
    });

    it('never logs or persists the encryption key', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { base, info, warn, error, debug, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-light', 'light');
        device.discovery$.next(true);

        device.error$.next(new InvalidEncryptionKeyError('Kitchen fan', 'AA:BB:CC:DD:EE:FF'));

        const logArguments = [base, info, warn, error, debug].flatMap((spy) => spy.mock.calls.flat());
        expect(JSON.stringify(logArguments)).not.toContain(VALID_KEY);
        const accessory = registeredAccessory(registerPlatformAccessories);
        expect(JSON.stringify(accessory.context)).not.toContain(VALID_KEY);
    });

    it('tailors the connection-handshake warning to whether a key is configured', () => {
        const withKey = createPlatform({
            devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY }],
        });
        withKey.didFinishLaunching();
        espDeviceAt(0).error$.next(new ConnectionHandshakeError('closed'));
        expect(withKey.warn).toHaveBeenCalledWith(expect.stringContaining('remove the "encryptionKey"'));

        const withoutKey = createPlatform({ devices: [{ host: 'esp-two.local' }] });
        withoutKey.didFinishLaunching();
        espDeviceAt(1).error$.next(new ConnectionHandshakeError('closed'));
        expect(withoutKey.warn).toHaveBeenCalledWith(expect.stringContaining('add its "encryptionKey"'));
    });

    it('cancels the pending discovery timeout when a terminal failure arrives', () => {
        vi.useFakeTimers();
        try {
            const helper = vi.fn(() => () => {});
            setupComponentHelper('light', helper);
            const { warn, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', encryptionKey: VALID_KEY }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            addComponent(device, 'office-light', 'light');

            device.error$.next(new EncryptionRequiredError());
            vi.advanceTimersByTime(20_000);
            expect(warn).not.toHaveBeenCalled();

            device.discovery$.next(true);
            expect(helper).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('passes invertFanDirection to the component helper', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('fan', helper);
        const { didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', invertFanDirection: true }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-fan', 'fan');
        device.discovery$.next(true);

        expect(helper).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'office-fan' }),
            expect.anything(),
            expect.anything(),
            { invertFanDirection: true },
        );
    });

    it('syncs the last known connection state into freshly added accessories', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { registerPlatformAccessories, didFinishLaunching } = createPlatform({
            // Two configured entries for the same host make onHomebridgeDidFinishLaunching run
            // addAccessories twice for it (the second run is the "subsequent" one).
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const firstDevice = espDeviceAt(0);
        const secondDevice = espDeviceAt(1);

        addComponent(firstDevice, 'office-light', 'light');
        firstDevice.discovery$.next(true);
        const accessory = registeredAccessory(registerPlatformAccessories);
        const sensorService = new SensorService();
        accessory.addService(sensorService);

        firstDevice.alive$.next(false); // watchDeviceConnection records the offline state for the host
        addComponent(secondDevice, 'office-light', 'light');
        secondDevice.discovery$.next(true); // subsequent addAccessories run

        // The service only got its characteristic through the fresh-accessory sync path.
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(false);

        secondDevice.alive$.next(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('re-associates cached accessories with their persisted host for status sync', () => {
        const { platform, registerPlatformAccessories, didFinishLaunching } = createPlatform({
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
        // No component discovery at all — the status write proves the cached accessory is
        // re-associated via context.host.
        espDeviceAt(0).alive$.next(true);
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('associates nothing for cached accessories from older disk caches without context.host', () => {
        const { platform, didFinishLaunching } = createPlatform({ devices: [{ host: 'esp-one.local' }] });
        const cached = new FakePlatformAccessory('old-cached-component', 'uuid-old-cached');
        const sensorService = new SensorService();
        cached.addService(sensorService);
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        didFinishLaunching();
        espDeviceAt(0).alive$.next(true);
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);
    });

    it('unregisters blacklisted cached accessories', () => {
        const { platform, unregisterPlatformAccessories } = createPlatform({ blacklist: ['forbidden'] });
        const cached = new FakePlatformAccessory('forbidden', 'uuid-forbidden');
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0][2][0]).toBe(cached);
        expect(internals(platform).accessories).toHaveLength(0);
    });

    it('guards against duplicate associations for the same host and component', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { platform, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const firstDevice = espDeviceAt(0);
        const secondDevice = espDeviceAt(1);

        addComponent(firstDevice, 'office-light', 'light');
        firstDevice.discovery$.next(true); // new accessory: registered once
        addComponent(secondDevice, 'office-light', 'light');
        secondDevice.discovery$.next(true); // existing accessory: reused

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const state = internals(platform);
        expect(state.accessories).toHaveLength(1);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(1);

        // configureAccessory twice does not double-push either.
        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
        cached.context.host = 'esp-one.local';
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        expect(state.accessories).toHaveLength(2);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(2);
    });

    it('terminates every device and drops later error emissions after shutdown', () => {
        const { error, didFinishLaunching, shutdown } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        shutdown();
        expect(espDeviceAt(0).terminate).toHaveBeenCalledTimes(1);
        expect(espDeviceAt(1).terminate).toHaveBeenCalledTimes(1);

        espDeviceAt(0).error$.next(new Error('late emission'));
        espDeviceAt(0).error$.next(new InvalidPasswordError('esp-one.local'));
        expect(error).not.toHaveBeenCalled(); // subscription unsubscribed: no logging anymore
    });

    it('binds a device discovered after the timeout warning and warns only once', () => {
        vi.useFakeTimers();
        try {
            const helper = vi.fn(() => () => {});
            setupComponentHelper('light', helper);
            const { warn, registerPlatformAccessories, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local' }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            addComponent(device, 'office-light', 'light');

            vi.advanceTimersByTime(10_000);
            expect(warn).toHaveBeenCalledTimes(1);

            // A delayed discovery remains subscribed, while the timeout diagnostic is one-shot.
            vi.advanceTimersByTime(20_000);
            expect(warn).toHaveBeenCalledTimes(1);
            device.discovery$.next(true);
            device.discovery$.next(true);

            expect(helper).toHaveBeenCalledTimes(1);
            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('binds a prompt discovery without emitting a timeout warning', () => {
        vi.useFakeTimers();
        try {
            const helper = vi.fn(() => () => {});
            setupComponentHelper('light', helper);
            const { warn, registerPlatformAccessories, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local' }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            addComponent(device, 'office-light', 'light');
            device.discovery$.next(true);

            vi.advanceTimersByTime(10_000);

            expect(helper).toHaveBeenCalledTimes(1);
            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('binds only once when discovery emits true multiple times', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-light', 'light');

        device.discovery$.next(true);
        device.discovery$.next(true);
        device.discovery$.next(true);

        expect(helper).toHaveBeenCalledTimes(1);
        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });

    it('cancels pending discovery setup when Homebridge shuts down', () => {
        vi.useFakeTimers();
        try {
            const helper = vi.fn(() => () => {});
            setupComponentHelper('light', helper);
            const { warn, registerPlatformAccessories, didFinishLaunching, shutdown } = createPlatform({
                devices: [{ host: 'esp-one.local' }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            addComponent(device, 'office-light', 'light');

            vi.advanceTimersByTime(10_000);
            expect(warn).toHaveBeenCalledTimes(1);

            shutdown();
            device.discovery$.next(true);
            vi.advanceTimersByTime(20_000);

            expect(helper).not.toHaveBeenCalled();
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('continues setting up other devices when a component helper throws', () => {
        const successfulHelper = vi.fn(() => () => {});
        setupComponentHelper(
            'broken-light',
            vi.fn(() => {
                throw new Error('component setup failed');
            }),
        );
        setupComponentHelper('light', successfulHelper);
        const { error, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();
        const firstDevice = espDeviceAt(0);
        const secondDevice = espDeviceAt(1);
        addComponent(firstDevice, 'broken-component', 'broken-light');
        addComponent(secondDevice, 'office-light', 'light');

        firstDevice.discovery$.next(true);
        secondDevice.discovery$.next(true);

        expect(successfulHelper).toHaveBeenCalledTimes(1);
        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Error while discovering or setting up accessories'),
            expect.any(Error),
        );
    });
});
