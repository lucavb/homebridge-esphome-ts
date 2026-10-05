import { Subscription, tap } from 'rxjs';
import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { BaseComponent } from 'esphome-ts';

type ServiceConstructor = (new (displayName?: string, subtype?: string) => Service) & { readonly UUID: string };

/**
 * The mapping that attaches one component onto an accessory: which service, which
 * characteristics, how state is read, applied, and pushed (GLOSSARY: component binding).
 *
 * Rows close over their typed component. A row without {@link ComponentBinding.read} wires
 * no `onGet`, one without {@link ComponentBinding.apply} wires no `onSet`, and a
 * {@link ComponentBinding.project} that returns `undefined` skips the push.
 */
export interface ComponentBinding {
    /** Service constructor class (e.g. `typeof Service.Switch` or `typeof Service.Lightbulb`). */
    readonly service: ServiceConstructor;
    /** Display name used when the service is added to the accessory. */
    readonly name: string;
    /** Optional service subtype (light effect switches). */
    readonly subtype?: string;
    readonly characteristic: WithUUID<new (...args: never[]) => Characteristic>;
    /** Wired as `onGet`; omit to leave the characteristic without a getter. */
    readonly read?: () => CharacteristicValue;
    /** Wired as `onSet`; omit to leave the characteristic without a setter. */
    readonly apply?: (value: CharacteristicValue) => void;
    /**
     * Push pipeline on `component.state$` emissions; a returned `undefined` skips the push.
     * Method-style on purpose: it allows assigning narrowly typed project functions
     * (such as light's row-state projection) under strictFunctionTypes.
     */
    project?(state: unknown): CharacteristicValue | undefined;
    /** After a successful apply, sibling rows of the same group get updateValue(false) (light effect switches). */
    readonly radioGroup?: string;
}

/**
 * Binds the given component's rows onto the accessory: find-or-add per service row
 * (matched on service UUID and optional subtype), wire `onSet`/`onGet` with the uniform
 * HapStatusError wrap, and push projected state per row through one owned `state$`
 * subscription per row (aggregated into the returned teardown).
 *
 * Push policy: device pushes land through `updateValue`, never `setValue` — `setValue`
 * re-enters the registered `onSet` handler (verified against @homebridge/hap-nodejs
 * Characteristic.js) and echoes commands back to the device, while `updateValue` writes
 * silently and still notifies HomeKit clients on change. Sibling pushes of a
 * {@link ComponentBinding.radioGroup} use the same silent path.
 *
 * Every handler error translates to `HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)` —
 * with real hap any handler throw already maps to -70402, so the wrap centralizes the idiom.
 * (HAPStatus is read off `api.hap` at runtime because homebridge 2.x exports it type-only.)
 *
 * @returns Teardown that unsubscribes all aggregated `state$` subscriptions of the binding.
 */
export const bindComponent = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
    bindings: ComponentBinding[],
): (() => void) => {
    const resolved = bindings.map(
        (row: ComponentBinding): { row: ComponentBinding; characteristic: Characteristic } => {
            let service = accessory.services.find(
                (accessoryService: Service) =>
                    accessoryService.UUID === row.service.UUID &&
                    (row.subtype === undefined || accessoryService.subtype === row.subtype),
            );
            if (!service) {
                service = accessory.addService(new row.service(row.name, row.subtype ?? ''));
            }

            const characteristic = service.getCharacteristic(row.characteristic);
            return { row, characteristic };
        },
    );

    const pushSiblings = (row: ComponentBinding, value: CharacteristicValue): void => {
        for (const { row: siblingRow, characteristic } of resolved) {
            if (siblingRow === row || siblingRow.radioGroup !== row.radioGroup) {
                continue;
            }
            characteristic.updateValue(value);
        }
    };

    const subscription = new Subscription();

    for (const { row, characteristic } of resolved) {
        const apply = row.apply;
        const read = row.read;

        if (apply) {
            characteristic.onSet(async (value: CharacteristicValue) => {
                try {
                    await apply(value);
                    if (row.radioGroup) {
                        pushSiblings(row, false);
                    }
                } catch {
                    throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
        }

        if (read) {
            characteristic.onGet(async () => {
                try {
                    return read();
                } catch {
                    throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
        }

        subscription.add(
            component.state$
                .pipe(
                    tap((state: unknown) => {
                        if (!row.project) {
                            return;
                        }
                        const value = row.project(state);
                        if (value === undefined) {
                            return;
                        }
                        characteristic.updateValue(value);
                    }),
                )
                .subscribe(),
        );
    }

    return () => {
        subscription.unsubscribe();
    };
};
