import { BehaviorSubject, Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';

import type { DeviceSource } from '../deviceSession.js';

/**
 * Structural double for `EspDevice`, faithful at the boundaries the Device session
 * exercises (CODING_STANDARDS fiction rule):
 *
 * - `alive$` starts with a buffered `false`, like esphome-ts v5's `socket.connected$`
 *   BehaviorSubject merged into `alive$`.
 * - `discovery$` starts `false` and emits `true` once the component list is known.
 * - `error$` is a hot Subject; terminal vs retryable classification is the session's job.
 * - `provideRetryObservable` records the cadence so specs can subscribe to it; the real
 *   library subscribes only while offline, so specs simulate a resubscription explicitly.
 *
 * The real class needs a socket, so it cannot run in-process here. Components are opaque
 * to this double; specs populate `components` with hap/Component fakes.
 */
export class FakeEspDevice implements DeviceSource {
    public readonly error$ = new Subject<unknown>();
    public readonly discovery$ = new BehaviorSubject<boolean>(false);
    public readonly alive$ = new BehaviorSubject<boolean>(false);
    public readonly components: Record<string, BaseComponent> = {};
    public retry$: Observable<unknown> | undefined;
    public terminateCount = 0;

    public provideRetryObservable(retry$: Observable<unknown>): void {
        this.retry$ = retry$;
    }

    public terminate(): void {
        this.terminateCount += 1;
    }

    public emitError(error: unknown): void {
        this.error$.next(error);
    }

    public emitDiscovery(discovered: boolean): void {
        this.discovery$.next(discovered);
    }

    public emitAlive(alive: boolean): void {
        this.alive$.next(alive);
    }
}

/** Boundary cast for component shapes the session only passes through. */
export const asComponent = (component: { name: string; type: string }): BaseComponent =>
    component as unknown as BaseComponent;

export const createFakeEspDevice = (components: Array<{ name: string; type: string }> = []): FakeEspDevice => {
    const device = new FakeEspDevice();
    for (const component of components) {
        device.components[component.name] = asComponent(component);
    }
    return device;
};
