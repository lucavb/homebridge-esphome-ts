import type { Logging } from 'homebridge';
import type { Observable } from 'rxjs';
import { BehaviorSubject, EMPTY, interval, of, shareReplay, Subject, Subscription } from 'rxjs';
import { distinctUntilChanged, filter, take, takeUntil, tap, timeout } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';
import { EspDevice } from 'esphome-ts';

import { describeDeviceError, isTerminalDeviceError } from './shared/deviceErrors.js';
import type { DeviceErrorKind } from './shared/deviceErrors.js';

/**
 * The Device session module owns the lifecycle of one Device: construction, the reconnect
 * cadence, terminal-failure latching, error logging, the debug dump, Connection status, and
 * the Discovery wait. The platform supplies a resolved transport config and receives only
 * the discovered Components, the alive stream, and a teardown.
 */

/** The transport fields the session needs; the platform keeps the HomeKit-side knobs. */
export interface DeviceTransportConfig {
    readonly host: string;
    readonly password?: string;
    readonly port?: number;
    readonly encryptionKey?: string;
    readonly retryAfter: number;
}

/**
 * Structural stand-in for `EspDevice`. Real `EspDevice` satisfies it; specs use the shared
 * fake in `src/testing/fakeEspDevice.ts` because the library needs a socket in-process.
 */
export interface DeviceSource {
    readonly error$: Observable<unknown>;
    readonly discovery$: Observable<boolean>;
    readonly alive$: Observable<boolean>;
    readonly components: Record<string, BaseComponent>;
    provideRetryObservable(retry$: Observable<unknown>): void;
    terminate(): void;
}

export type DebugDumpWriter = (
    host: string,
    device: DeviceSource,
    onWriteError: (error: unknown) => void,
) => Subscription | undefined;

export interface DeviceSessionDeps {
    readonly log: Logging;
    /** Defaults to constructing a real `EspDevice`; specs inject the shared fake. */
    readonly createDevice?: (config: DeviceTransportConfig) => DeviceSource;
    /** Presence means debug dumps are enabled; the platform injects this only when `debug` is true. */
    readonly writeDebugDump?: DebugDumpWriter;
}

export interface DeviceSession {
    /** The Components of the Device, emitted once and replayed to late subscribers. */
    readonly components$: Observable<ReadonlyArray<BaseComponent>>;
    /** Deduplicated transport state; the session logs re-established/lost, the platform applies it. */
    readonly alive$: Observable<boolean>;
    /** Idempotent: terminates the Device, unsubscribes the session, and completes both streams. */
    stop(): void;
}

/** How long a Device may stay silent before the "could not be reached" warning. */
const DISCOVERY_TIMEOUT = 10 * 1000;

const createEspDevice = (config: DeviceTransportConfig): DeviceSource =>
    new EspDevice(
        config.host,
        config.password,
        config.port,
        config.encryptionKey === undefined ? undefined : { encryptionKey: config.encryptionKey },
    );

/** A session that owns nothing, for a Device the library refused to construct. */
const noopSession = (): DeviceSession => ({
    components$: EMPTY,
    alive$: of(false),
    stop: () => undefined,
});

export const startDeviceSession = (config: DeviceTransportConfig, deps: DeviceSessionDeps): DeviceSession => {
    const log = deps.log;
    const createDevice = deps.createDevice ?? createEspDevice;

    let device: DeviceSource;
    try {
        device = createDevice(config);
    } catch (error) {
        const description = describeDeviceError(config.host, error, {
            encryptionKeyConfigured: config.encryptionKey !== undefined,
        });
        log.error(description.message ?? `Could not create the esphome device ${config.host}.`, error);
        return noopSession();
    }

    const subscription = new Subscription();
    const componentsSubject = new Subject<ReadonlyArray<BaseComponent>>();
    const components$ = componentsSubject.pipe(shareReplay({ bufferSize: 1, refCount: false }));
    const aliveSubject = new BehaviorSubject<boolean>(false);
    const alive$ = aliveSubject.asObservable().pipe(distinctUntilChanged());
    let stopped = false;

    if (deps.writeDebugDump !== undefined) {
        const dumpSubscription = deps.writeDebugDump(config.host, device, (error) => {
            log.warn(
                `Writing the raw data for ${config.host} to /tmp failed;` +
                    ' no further debug dumps are written for this device.',
            );
            log.debug('debug dump write failed', error);
        });
        if (dumpSubscription !== undefined) {
            log('Writing the raw data from your ESP Device to /tmp');
            subscription.add(dumpSubscription);
        } else {
            log.debug(`No socket to mirror for ${config.host}; debug dumps are unavailable.`);
        }
    }

    // esphome-ts latches rejected credentials and encryption mismatches as terminal (the
    // config cannot change while connected), so stop the retry cadence and the Discovery
    // wait instead of logging futile attempts. The notifier must replay: esphome-ts tears
    // the provided cadence down when the Device connects and subscribes a fresh copy after
    // the terminal failure disconnects it. A cold take(1) would have missed the error.
    const terminalFailure$ = device.error$.pipe(
        filter(isTerminalDeviceError),
        take(1),
        shareReplay({ bufferSize: 1, refCount: false }),
    );
    const warnedKinds = new Set<DeviceErrorKind>();
    subscription.add(
        device.error$.subscribe((error) => {
            const description = describeDeviceError(config.host, error, {
                encryptionKeyConfigured: config.encryptionKey !== undefined,
            });
            if (description.terminal) {
                log.error(description.message ?? `Error from esphome device ${config.host}`);
                return;
            }
            if (description.warnOnce && description.message !== undefined && !warnedKinds.has(description.kind)) {
                warnedKinds.add(description.kind);
                log.warn(description.message);
                return;
            }
            log.debug(`Error from esphome device ${config.host}`, error);
        }),
    );
    device.provideRetryObservable(
        interval(config.retryAfter).pipe(
            takeUntil(terminalFailure$),
            tap(() => log.info(`Trying to reconnect now to device ${config.host}`)),
        ),
    );

    let everConnected = false;
    subscription.add(
        device.alive$.pipe(distinctUntilChanged()).subscribe((alive) => {
            aliveSubject.next(alive);
            if (alive) {
                if (everConnected) {
                    log.info(`Connection to the esphome device ${config.host} re-established.`);
                }
                everConnected = true;
            } else if (everConnected) {
                log.warn(`Connection to the esphome device ${config.host} was lost. Values may be stale.`);
            }
        }),
    );

    subscription.add(
        device.discovery$
            .pipe(
                filter((value: boolean) => value),
                take(1),
                timeout({
                    first: DISCOVERY_TIMEOUT,
                    with: () => {
                        log.warn(`The device under the host ${config.host} could not be reached.`);
                        return device.discovery$.pipe(
                            filter((value: boolean) => value),
                            take(1),
                        );
                    },
                }),
                takeUntil(terminalFailure$),
            )
            .subscribe({
                next: () => {
                    componentsSubject.next(Object.values(device.components));
                    componentsSubject.complete();
                },
                error: (error: unknown) => {
                    log.error(`Error while discovering or setting up accessories for device ${config.host}.`, error);
                    componentsSubject.complete();
                },
                complete: () => {
                    // takeUntil (terminal failure) and a completed discovery stream both close
                    // the session's discovery wait without Components.
                    componentsSubject.complete();
                },
            }),
    );

    const stop = (): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        // Terminate first, like the platform's old shutdown loop, so a synchronous
        // terminate-time emission still reaches the subscriber before it is torn down.
        device.terminate();
        subscription.unsubscribe();
        componentsSubject.complete();
        aliveSubject.complete();
    };

    return { components$, alive$, stop };
};
