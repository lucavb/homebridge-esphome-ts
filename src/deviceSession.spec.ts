import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logging } from 'homebridge';
import { Subscription } from 'rxjs';
import type { Observable } from 'rxjs';
import {
    ConnectionHandshakeError,
    EncryptionHandshakeError,
    EncryptionPlaintextError,
    EncryptionRequiredError,
    InvalidEncryptionKeyError,
    InvalidEncryptionKeyFormatError,
    InvalidPasswordError,
} from 'esphome-ts';

import { startDeviceSession } from './deviceSession.js';
import type { DeviceTransportConfig } from './deviceSession.js';
import { asComponent, createFakeEspDevice } from './testing/fakeEspDevice.js';
import type { FakeEspDevice } from './testing/fakeEspDevice.js';

const createFakeLogging = () => {
    const base = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const log = Object.assign(base, { info, warn, error, debug }) as unknown as Logging;
    return { log, base, info, warn, error, debug };
};

const config: DeviceTransportConfig = {
    host: 'esp-one.local',
    retryAfter: 1_000,
};

interface Collected<T> {
    readonly values: T[];
    completed: boolean;
    error: unknown;
}

const collect = <T>(source: Observable<T>): { state: Collected<T>; subscription: Subscription } => {
    const state: Collected<T> = { values: [], completed: false, error: undefined };
    const subscription = source.subscribe({
        next: (value) => state.values.push(value),
        complete: () => {
            state.completed = true;
        },
        error: (error: unknown) => {
            state.error = error;
        },
    });
    return { state, subscription };
};

const start = (
    device: FakeEspDevice,
    options: { writeDebugDump?: Parameters<typeof startDeviceSession>[1]['writeDebugDump'] } = {},
) => {
    const logging = createFakeLogging();
    const createDevice = vi.fn(() => device);
    const session = startDeviceSession(config, {
        log: logging.log,
        createDevice,
        writeDebugDump: options.writeDebugDump,
    });
    return { session, createDevice, ...logging };
};

beforeEach(() => {
    vi.useRealTimers();
});

describe('startDeviceSession', () => {
    it('constructs the Device from the transport config and provides a retry cadence', () => {
        const device = createFakeEspDevice();
        const { createDevice } = start(device);

        expect(createDevice).toHaveBeenCalledWith(config);
        expect(device.retry$).toBeDefined();
    });

    it('classifies a construction throw, logs it, and returns a no-op session', () => {
        const logging = createFakeLogging();
        const session = startDeviceSession(config, {
            log: logging.log,
            createDevice: () => {
                throw new InvalidEncryptionKeyFormatError('the key is the all-zero sentinel');
            },
        });

        expect(logging.error).toHaveBeenCalledWith(expect.stringContaining('all-zero'), expect.anything());
        const components = collect(session.components$);
        expect(components.state.values).toEqual([]);
        expect(components.state.completed).toBe(true);
        const alive = collect(session.alive$);
        expect(alive.state.values).toEqual([false]);
        expect(() => session.stop()).not.toThrow();
    });

    it('never logs the encryption key when construction fails', () => {
        const logging = createFakeLogging();
        const key = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
        startDeviceSession(
            { ...config, encryptionKey: key },
            {
                log: logging.log,
                createDevice: () => {
                    throw new InvalidEncryptionKeyFormatError('bad key');
                },
            },
        );

        const argumentsJson = [logging.base, logging.info, logging.warn, logging.error, logging.debug]
            .flatMap((spy) => spy.mock.calls.flat())
            .filter((value) => typeof value === 'string');
        expect(argumentsJson.join(' ')).not.toContain(key);
    });

    it('debugs a non-terminal error and errors a terminal one', () => {
        const device = createFakeEspDevice();
        const { debug, error } = start(device);

        device.emitError(new Error('boom'));
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'), expect.anything());
        expect(error).not.toHaveBeenCalled();

        device.emitError(new InvalidPasswordError('esp-one.local'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('rejected your password'));
    });

    it('stops the retry cadence on a terminal failure', () => {
        vi.useFakeTimers();
        try {
            const device = createFakeEspDevice();
            const { info } = start(device);
            const retry = collect(device.retry$ as Observable<unknown>);

            vi.advanceTimersByTime(2_000);
            expect(retry.state.values).toHaveLength(2);
            expect(info).toHaveBeenCalledWith(expect.stringContaining('Trying to reconnect'));

            device.emitError(new InvalidPasswordError('esp-one.local'));
            expect(retry.subscription.closed).toBe(true);

            vi.advanceTimersByTime(5_000);
            expect(retry.state.values).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'InvalidEncryptionKeyError',
            () => new InvalidEncryptionKeyError('Kitchen fan', 'AA:BB:CC'),
            'rejected your encryption key',
        ],
        ['EncryptionRequiredError', () => new EncryptionRequiredError(), 'requires API encryption'],
        ['EncryptionPlaintextError', () => new EncryptionPlaintextError(), 'not using API encryption'],
    ])('stops the cadence and logs actionable text on terminal %s', (_, makeError, expectedText) => {
        const device = createFakeEspDevice();
        const { error } = start(device);
        const retry = collect(device.retry$ as Observable<unknown>);

        device.emitError(makeError());

        expect(retry.subscription.closed).toBe(true);
        expect(error).toHaveBeenCalledWith(expect.stringContaining(expectedText));
    });

    it.each([
        ['EncryptionHandshakeError', () => new EncryptionHandshakeError('bad hello')],
        ['ConnectionHandshakeError', () => new ConnectionHandshakeError('closed')],
    ])('keeps the cadence and warns once on retryable %s', (_, makeError) => {
        const device = createFakeEspDevice();
        const { warn } = start(device);
        const retry = collect(device.retry$ as Observable<unknown>);

        device.emitError(makeError());

        expect(retry.subscription.closed).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'));
    });

    it('replays a terminal failure to a cadence the library resubscribes', () => {
        const device = createFakeEspDevice();
        start(device);
        const retry$ = device.retry$ as Observable<unknown>;

        const connectedCadence = retry$.subscribe();
        connectedCadence.unsubscribe();
        device.emitError(new InvalidPasswordError('esp-one.local'));

        const resubscribedCadence = retry$.subscribe();
        expect(resubscribedCadence.closed).toBe(true);
    });

    it('keeps the cadence alive after a retryable handshake failure', () => {
        vi.useFakeTimers();
        try {
            const device = createFakeEspDevice();
            start(device);
            const retry = collect(device.retry$ as Observable<unknown>);

            device.emitError(new EncryptionHandshakeError('bad hello'));
            expect(retry.subscription.closed).toBe(false);
            vi.advanceTimersByTime(1_000);
            expect(retry.state.values).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('warns once per retryable kind and then drops to debug', () => {
        const device = createFakeEspDevice();
        const { warn, debug } = start(device);

        device.emitError(new EncryptionHandshakeError('bad hello'));
        device.emitError(new ConnectionHandshakeError('closed'));
        expect(warn).toHaveBeenCalledTimes(2);

        device.emitError(new EncryptionHandshakeError('again'));
        device.emitError(new ConnectionHandshakeError('again'));
        expect(warn).toHaveBeenCalledTimes(2);
        expect(debug).toHaveBeenCalledTimes(2);
    });

    it('applies the buffered offline state without a false alarm', () => {
        const device = createFakeEspDevice();
        const { session, info, warn } = start(device);
        const alive = collect(session.alive$);

        expect(alive.state.values).toEqual([false]);
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(device.alive$.value).toBe(false);
    });

    it('logs a warning on loss after a connection and info on reconnect, and exposes the states', () => {
        const device = createFakeEspDevice();
        const { session, info, warn } = start(device);
        const alive = collect(session.alive$);

        device.emitAlive(true);
        expect(info).not.toHaveBeenCalled();
        device.emitAlive(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('was lost'));
        device.emitAlive(true);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('re-established'));

        expect(alive.state.values).toEqual([false, true, false, true]);
    });

    it('deduplicates consecutive alive states', () => {
        const device = createFakeEspDevice();
        const { session, info, warn } = start(device);
        const alive = collect(session.alive$);

        device.emitAlive(true);
        device.emitAlive(true);
        device.emitAlive(false);
        device.emitAlive(false);
        device.emitAlive(true);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledTimes(1);
        expect(alive.state.values).toEqual([false, true, false, true]);
    });

    it('starts and owns the debug dump, reporting a failed write once', () => {
        const dumpSubscription = new Subscription();
        const writeDebugDump = vi.fn((host: string, device: unknown, onWriteError: (error: unknown) => void) => {
            void host;
            void device;
            void onWriteError;
            return dumpSubscription;
        });
        const device = createFakeEspDevice();
        const { base, warn, debug, session } = start(device, { writeDebugDump });

        expect(writeDebugDump).toHaveBeenCalledWith(config.host, device, expect.any(Function));
        expect(base).toHaveBeenCalledWith('Writing the raw data from your ESP Device to /tmp');
        const onWriteError = writeDebugDump.mock.calls[0]?.[2] as (error: unknown) => void;
        onWriteError(new Error('ENOSPC'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Writing the raw data'));
        expect(debug).toHaveBeenCalledWith('debug dump write failed', expect.anything());

        expect(dumpSubscription.closed).toBe(false);
        session.stop();
        expect(dumpSubscription.closed).toBe(true);
    });

    it('reports a missing socket when the debug writer cannot tap one', () => {
        const device = createFakeEspDevice();
        const { base, debug } = start(device, { writeDebugDump: () => undefined });

        expect(base).not.toHaveBeenCalledWith(expect.stringContaining('Writing the raw data'));
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('debug dumps are unavailable'));
    });

    it('does not start a debug dump when no writer is injected', () => {
        const device = createFakeEspDevice();
        const { base } = start(device);

        expect(base).not.toHaveBeenCalledWith(expect.stringContaining('Writing the raw data'));
    });

    it('emits the discovered Components once and completes, replaying to late subscribers', () => {
        const component = asComponent({ name: 'office-light', type: 'light' });
        const device = createFakeEspDevice([{ name: 'office-light', type: 'light' }]);
        const { session } = start(device);
        const components = collect(session.components$);

        device.emitDiscovery(true);
        device.emitDiscovery(true);

        expect(components.state.values).toEqual([[component]]);
        expect(components.state.completed).toBe(true);

        const late = collect(session.components$);
        expect(late.state.values).toEqual([[component]]);
        expect(late.state.completed).toBe(true);
    });

    it('warns once when Discovery times out and still binds a late Device', () => {
        vi.useFakeTimers();
        try {
            const device = createFakeEspDevice([{ name: 'office-light', type: 'light' }]);
            const { warn, session } = start(device);
            const components = collect(session.components$);

            vi.advanceTimersByTime(10_000);
            expect(warn).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(20_000);
            expect(warn).toHaveBeenCalledTimes(1);

            device.emitDiscovery(true);
            expect(components.state.values).toEqual([[expect.objectContaining({ name: 'office-light' })]]);
            expect(components.state.completed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels the pending Discovery wait when a terminal failure arrives', () => {
        vi.useFakeTimers();
        try {
            const device = createFakeEspDevice([{ name: 'office-light', type: 'light' }]);
            const { warn, session } = start(device);
            const components = collect(session.components$);

            device.emitError(new EncryptionRequiredError());
            vi.advanceTimersByTime(20_000);
            expect(warn).not.toHaveBeenCalled();

            device.emitDiscovery(true);
            expect(components.state.values).toEqual([]);
            expect(components.state.completed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stop is idempotent, terminates the Device, and completes both streams', () => {
        const device = createFakeEspDevice([{ name: 'office-light', type: 'light' }]);
        const { session } = start(device);
        const components = collect(session.components$);
        const alive = collect(session.alive$);

        session.stop();
        session.stop();

        expect(device.terminateCount).toBe(1);
        expect(components.state.completed).toBe(true);
        expect(alive.state.completed).toBe(true);
    });

    it('drops error and discovery emissions after stop', () => {
        const device = createFakeEspDevice();
        const { error, debug, session } = start(device);
        session.stop();

        device.emitError(new InvalidPasswordError('esp-one.local'));
        device.emitDiscovery(true);

        expect(error).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalled();
    });
});
