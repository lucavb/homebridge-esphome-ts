import {
    ConnectionHandshakeError,
    EncryptionHandshakeError,
    EncryptionPlaintextError,
    EncryptionRequiredError,
    InvalidEncryptionKeyError,
    InvalidEncryptionKeyFormatError,
    InvalidPasswordError,
} from 'esphome-ts';

/** Failure classes that the library latches; retrying cannot succeed until the config changes. */
export type DeviceErrorKind =
    | 'password-rejected'
    | 'encryption-key-rejected'
    | 'encryption-required'
    | 'encryption-plaintext'
    | 'encryption-key-format'
    | 'encryption-handshake'
    | 'connection-handshake'
    | 'other';

export interface DeviceErrorDescription {
    readonly kind: DeviceErrorKind;
    /** The library stops reconnecting and discovery never completes. */
    readonly terminal: boolean;
    /** Worth one user-visible warning per device, then debug-only. */
    readonly warnOnce: boolean;
    /** User-facing text. Never contains key material. */
    readonly message?: string;
}

interface DeviceErrorContext {
    readonly encryptionKeyConfigured: boolean;
}

/**
 * The single source of terminality. `describeDeviceError` derives its `terminal` flag from
 * this predicate, so adding a class here is enough to stop retries and raise the log level.
 *
 * `InvalidEncryptionKeyFormatError` never reaches `error$` — the library throws it from the
 * constructor — but it is included so the platform's construction-time catch classifies it as
 * terminal rather than as an unknown retryable failure.
 */
export const isTerminalDeviceError = (error: unknown): boolean =>
    error instanceof InvalidPasswordError ||
    error instanceof InvalidEncryptionKeyError ||
    error instanceof EncryptionRequiredError ||
    error instanceof EncryptionPlaintextError ||
    error instanceof InvalidEncryptionKeyFormatError;

const reportedIdentity = (error: InvalidEncryptionKeyError): string => {
    const identity = [error.serverName, error.serverMac].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return identity.length === 0 ? '' : ` (unauthenticated identity: ${identity.join(', ')})`;
};

const formatDetail = (error: InvalidEncryptionKeyFormatError): string =>
    error.message.includes('all-zero')
        ? 'it is the all-zero provisioning sentinel'
        : 'it is not a base64-encoded 32-byte value';

/**
 * Translates the esphome-ts failure taxonomy into actionable Homebridge text.
 *
 * Terminal failures need a config change (password, key, encryption mismatch), so they
 * are logged as errors and stop the platform's retry cadence. Handshake failures are
 * retryable and re-emit on every attempt; they earn one warning per device and then
 * drop to debug so a wrong host or plaintext device does not flood the log.
 */
export const describeDeviceError = (
    host: string,
    error: unknown,
    context: DeviceErrorContext,
): DeviceErrorDescription => {
    const terminal = isTerminalDeviceError(error);
    if (error instanceof InvalidPasswordError) {
        return {
            kind: 'password-rejected',
            terminal,
            warnOnce: false,
            message:
                `The esphome device ${host} rejected your password.` +
                ' Please check the "password" configured for this device.',
        };
    }
    if (error instanceof InvalidEncryptionKeyError) {
        return {
            kind: 'encryption-key-rejected',
            terminal,
            warnOnce: false,
            message:
                `The esphome device ${host}${reportedIdentity(error)} rejected your encryption key.` +
                ' Check the "encryptionKey" configured for this device; after a reflash or key rotation' +
                ' it must be updated.',
        };
    }
    if (error instanceof EncryptionRequiredError) {
        return {
            kind: 'encryption-required',
            terminal,
            warnOnce: false,
            message:
                `The esphome device ${host} requires API encryption, but no "encryptionKey" is configured.` +
                ' Add its "encryptionKey" (the key from api: encryption: key:) to this device\'s' +
                ' "devices" entry.',
        };
    }
    if (error instanceof EncryptionPlaintextError) {
        return {
            kind: 'encryption-plaintext',
            terminal,
            warnOnce: false,
            message:
                `The esphome device ${host} is not using API encryption, but an "encryptionKey" is configured.` +
                ' Remove the "encryptionKey" for this device or enable encryption on the device.',
        };
    }
    if (error instanceof InvalidEncryptionKeyFormatError) {
        return {
            kind: 'encryption-key-format',
            terminal,
            warnOnce: false,
            message: `The "encryptionKey" configured for ${host} is invalid: ${formatDetail(error)}.`,
        };
    }
    if (error instanceof EncryptionHandshakeError) {
        return {
            kind: 'encryption-handshake',
            terminal,
            warnOnce: true,
            message:
                `Could not establish the encrypted API session with ${host}.` +
                ' Check that the "encryptionKey" matches this device and that its firmware supports' +
                ' this protocol version.',
        };
    }
    if (error instanceof ConnectionHandshakeError) {
        return {
            kind: 'connection-handshake',
            terminal,
            warnOnce: true,
            message: context.encryptionKeyConfigured
                ? `The esphome device ${host} closed the connection before completing the API handshake.` +
                  ' Check the host/port; if encryption was disabled on the device, remove the "encryptionKey".'
                : `The esphome device ${host} closed the connection before completing the API handshake.` +
                  ' Check the host/port; if the device uses api: encryption:, add its "encryptionKey".',
        };
    }
    return { kind: 'other', terminal, warnOnce: false };
};
