import { BehaviorSubject, ReplaySubject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';

import type { DeviceSession } from '../deviceSession.js';

/**
 * Structural double for `DeviceSession`, faithful at the boundaries its consumers exercise
 * (CODING_STANDARDS fiction rule):
 *
 * - `components$` replays its one emission (and completion) to late subscribers, like the
 *   session's `shareReplay({ bufferSize: 1, refCount: false })`.
 * - `alive$` is BehaviorSubject-backed, starts `false`, and is deduplicated, like the
 *   session's `distinctUntilChanged` over an initial `false`.
 * - `stop` completes both streams and counts calls; the real session also terminates the Device.
 *
 * Specs drive it with `emitComponents` / `emitAlive`; consumers only see the `DeviceSession`
 * interface, so this double cannot leak fake-only members into production code.
 */
export interface FakeDeviceSession {
    readonly session: DeviceSession;
    readonly components$: ReplaySubject<ReadonlyArray<BaseComponent>>;
    /** The source subject, exposed so specs can inspect its observers; `session.alive$` is deduplicated. */
    readonly alive$: BehaviorSubject<boolean>;
    /** Emits the one Component list and completes it, like the session's Discovery wait. */
    emitComponents(components: ReadonlyArray<BaseComponent>): void;
    emitAlive(alive: boolean): void;
    stopCount(): number;
}

export const createFakeDeviceSession = (): FakeDeviceSession => {
    const components$ = new ReplaySubject<ReadonlyArray<BaseComponent>>(1);
    const aliveSource$ = new BehaviorSubject<boolean>(false);
    const alive$ = aliveSource$.pipe(distinctUntilChanged());
    let stops = 0;
    let stopped = false;

    const stop = (): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        stops += 1;
        components$.complete();
        aliveSource$.complete();
    };

    return {
        session: { components$, alive$, stop },
        components$,
        alive$: aliveSource$,
        emitComponents: (components) => {
            components$.next(components);
            components$.complete();
        },
        emitAlive: (alive) => {
            aliveSource$.next(alive);
        },
        stopCount: () => stops,
    };
};
