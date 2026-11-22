import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { CoverComponent, CoverOperation } from 'esphome-ts';
import type { BaseComponent, CoverStateEvent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';

/**
 * esphome covers report position and tilt in the 0..1 range where 1 = open / fully tilted open.
 * HomeKit position uses the same orientation in integer percent (0..100), so only the unit
 * converts; tilt angles map linearly onto integer degrees in the -90..90 range.
 */
const percentFromPosition = (position: number | undefined): number | undefined =>
    position === undefined ? undefined : Math.round(position * 100);

const angleFromTilt = (tilt: number | undefined): number | undefined =>
    tilt === undefined ? undefined : Math.round(tilt * 180 - 90);

export const coverHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!(component instanceof CoverComponent)) {
        return undefined;
    }
    const { Characteristic: CharacteristicClass, Service } = api.hap;
    /** HAP enums are read off api.hap at runtime (homebridge exports them type-only); never raw numbers. */
    const { DECREASING, INCREASING, STOPPED } = CharacteristicClass.PositionState;

    let commandedTargetPosition: number | undefined;
    let commandedTargetTilt: number | undefined;

    const percentFromReportedPosition = (position: number | undefined): number | undefined => {
        if (position !== undefined) {
            return percentFromPosition(position);
        }
        // ESPHome API <1.1 only reports the legacy open/closed state, exposed version-correctly
        // through isClosed. Modern APIs provide position feedback even without position control.
        const isClosed = component.isClosed;
        if (isClosed !== undefined) {
            return isClosed ? 0 : 100;
        }
        return undefined;
    };

    const currentPercent = (): number => {
        const percent = percentFromReportedPosition(component.position);
        if (percent === undefined) {
            // Before the first state arrives there is nothing honest to serve: a GET is a
            // communication failure, while pushes simply skip (see the sensor.ts convention).
            throw new Error('cover position not reported yet');
        }
        return percent;
    };

    // BaseComponent updates its normalized public state before notifying state$ observers.
    // Do not read CoverStateEvent.position here: older protocol decoders default that field to 0.
    const projectPosition = (): number | undefined => percentFromReportedPosition(component.position);

    const operationToPositionState = (operation: CoverOperation | undefined): CharacteristicValue => {
        if (operation === CoverOperation.COVER_OPERATION_IS_OPENING) {
            return INCREASING;
        }
        if (operation === CoverOperation.COVER_OPERATION_IS_CLOSING) {
            return DECREASING;
        }
        // COVER_OPERATION_IDLE and any pre-state undefined both read as at-rest.
        return STOPPED;
    };

    const currentTiltAngle = (): number => {
        const angle = angleFromTilt(component.tilt);
        if (angle === undefined) {
            // Same not-yet-served convention as CurrentPosition below.
            throw new Error('cover tilt not reported yet');
        }
        return angle;
    };

    const bindings: ComponentBinding[] = [
        {
            service: Service.WindowCovering,
            name: component.name,
            characteristic: CharacteristicClass.CurrentPosition,
            read: currentPercent,
            project: projectPosition,
        },
        {
            service: Service.WindowCovering,
            name: component.name,
            characteristic: CharacteristicClass.TargetPosition,
            read: () => commandedTargetPosition ?? currentPercent(),
            project: (state: CoverStateEvent) => {
                const percent = projectPosition();
                if (percent === undefined) {
                    return undefined;
                }

                const isMoving =
                    state.currentOperation === CoverOperation.COVER_OPERATION_IS_OPENING ||
                    state.currentOperation === CoverOperation.COVER_OPERATION_IS_CLOSING;
                if (commandedTargetPosition !== undefined && (isMoving || state.currentOperation === undefined)) {
                    return commandedTargetPosition;
                }

                // Any reported idle state reconciles the pending command to actual position,
                // including an idle notification that arrives before expected motion.
                commandedTargetPosition = undefined;
                return percent;
            },
            apply: (value) => {
                if (typeof value !== 'number') {
                    return;
                }
                if (component.supportsPosition) {
                    component.setPosition(value / 100);
                } else {
                    // Stateless covers only expose open/close; 50% is the midpoint between them.
                    if (value >= 50) {
                        component.open();
                    } else {
                        component.close();
                    }
                }
                commandedTargetPosition = value;
            },
        },
        {
            service: Service.WindowCovering,
            name: component.name,
            characteristic: CharacteristicClass.PositionState,
            read: () => operationToPositionState(component.operation),
            project: (state: CoverStateEvent) => operationToPositionState(state.currentOperation),
        },
    ];

    if (component.supportsStop) {
        bindings.push({
            service: Service.WindowCovering,
            name: component.name,
            characteristic: CharacteristicClass.HoldPosition,
            read: () => false,
            apply: (value) => {
                if (value === true) {
                    component.stop();
                }
            },
        });
    }

    if (component.supportsTilt) {
        bindings.push(
            {
                service: Service.WindowCovering,
                name: component.name,
                characteristic: CharacteristicClass.CurrentHorizontalTiltAngle,
                read: currentTiltAngle,
                project: (state: CoverStateEvent) => angleFromTilt(state.tilt),
            },
            {
                service: Service.WindowCovering,
                name: component.name,
                characteristic: CharacteristicClass.TargetHorizontalTiltAngle,
                read: () => commandedTargetTilt ?? currentTiltAngle(),
                project: () => {
                    const angle = angleFromTilt(component.tilt);
                    if (angle === undefined) {
                        return undefined;
                    }
                    // Tilt has no independent operation/completion signal. A device report
                    // that differs from the command is authoritative (including rejection or
                    // a partial/reconfigured stop), so discard the stale optimistic target.
                    commandedTargetTilt = undefined;
                    return angle;
                },
                apply: (value) => {
                    if (typeof value === 'number') {
                        component.setTilt((value + 90) / 180);
                        commandedTargetTilt = value;
                    }
                },
            },
        );
    }

    return bindComponent(component, accessory, api, bindings);
};
