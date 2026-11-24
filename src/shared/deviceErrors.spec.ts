import { describe, expect, it } from 'vitest';
import {
    ConnectionHandshakeError,
    EncryptionHandshakeError,
    EncryptionPlaintextError,
    EncryptionRequiredError,
    InvalidEncryptionKeyError,
    InvalidEncryptionKeyFormatError,
    InvalidPasswordError,
} from 'esphome-ts';

import { describeDeviceError, isTerminalDeviceError } from './deviceErrors.js';

const HOST = 'esp-one.local';
const withKey = { encryptionKeyConfigured: true };
const withoutKey = { encryptionKeyConfigured: false };

describe('describeDeviceError', () => {
    it('treats a rejected password as terminal and names the password setting', () => {
        const description = describeDeviceError(HOST, new InvalidPasswordError(HOST), withoutKey);

        expect(description).toMatchObject({ kind: 'password-rejected', terminal: true, warnOnce: false });
        expect(description.message).toContain(HOST);
        expect(description.message).toContain('"password"');
    });

    it('names the reported device identity on a rejected encryption key', () => {
        const description = describeDeviceError(
            HOST,
            new InvalidEncryptionKeyError('Kitchen fan', 'AA:BB:CC:DD:EE:FF'),
            withKey,
        );

        expect(description).toMatchObject({ kind: 'encryption-key-rejected', terminal: true, warnOnce: false });
        expect(description.message).toContain(HOST);
        expect(description.message).toContain('Kitchen fan');
        expect(description.message).toContain('AA:BB:CC:DD:EE:FF');
        expect(description.message).toContain('unauthenticated identity');
        expect(description.message).toContain('"encryptionKey"');
    });

    it('does not invent identity details when the server hello did not provide them', () => {
        const description = describeDeviceError(HOST, new InvalidEncryptionKeyError(), withKey);

        expect(description.message).toContain(HOST);
        expect(description.message).not.toContain('unauthenticated identity');
    });

    it('includes whichever identity field the server hello provided', () => {
        const nameOnly = describeDeviceError(HOST, new InvalidEncryptionKeyError('Kitchen fan'), withKey);
        expect(nameOnly.message).toContain('Kitchen fan');
        expect(nameOnly.message).not.toContain('undefined');

        const macOnly = describeDeviceError(HOST, new InvalidEncryptionKeyError(undefined, 'AA:BB'), withKey);
        expect(macOnly.message).toContain('AA:BB');
        expect(macOnly.message).not.toContain('undefined');
    });

    it('explains a missing key and a key configured against a plaintext device', () => {
        const required = describeDeviceError(HOST, new EncryptionRequiredError(), withoutKey);
        expect(required).toMatchObject({ kind: 'encryption-required', terminal: true });
        expect(required.message).toContain('requires API encryption');
        expect(required.message).toContain('api: encryption: key:');

        const plaintext = describeDeviceError(HOST, new EncryptionPlaintextError(), withKey);
        expect(plaintext).toMatchObject({ kind: 'encryption-plaintext', terminal: true });
        expect(plaintext.message).toContain('Remove the "encryptionKey"');
    });

    it('reports an invalid key with a fixed message instead of echoing library text', () => {
        const description = describeDeviceError(
            HOST,
            new InvalidEncryptionKeyFormatError('encryptionKey must not be the all-zero provisioning sentinel'),
            withKey,
        );

        expect(description).toMatchObject({ kind: 'encryption-key-format', terminal: true });
        expect(description.message).toContain('all-zero provisioning sentinel');
        expect(description.message).not.toContain('encryptionKey must be');
    });

    it('maps the non-sentinel format message to fixed text', () => {
        const description = describeDeviceError(
            HOST,
            new InvalidEncryptionKeyFormatError('encryptionKey must be a base64-encoded 32-byte value'),
            withKey,
        );

        expect(description.message).toContain('not a base64-encoded 32-byte value');
        expect(description.message).not.toContain('encryptionKey must be');
    });

    it('warns once for retryable handshake failures', () => {
        const encryptionHandshake = describeDeviceError(HOST, new EncryptionHandshakeError('bad hello'), withKey);
        expect(encryptionHandshake).toMatchObject({
            kind: 'encryption-handshake',
            terminal: false,
            warnOnce: true,
        });
        expect(encryptionHandshake.message).toContain('"encryptionKey"');

        const connectionHandshake = describeDeviceError(HOST, new ConnectionHandshakeError('closed'), withKey);
        expect(connectionHandshake).toMatchObject({
            kind: 'connection-handshake',
            terminal: false,
            warnOnce: true,
        });
    });

    it('tailors the connection-handshake hint to whether a key is configured', () => {
        const withKeyMessage = describeDeviceError(HOST, new ConnectionHandshakeError('closed'), withKey).message;
        expect(withKeyMessage).toContain('remove the "encryptionKey"');

        const withoutKeyMessage = describeDeviceError(HOST, new ConnectionHandshakeError('closed'), withoutKey).message;
        expect(withoutKeyMessage).toContain('add its "encryptionKey"');
    });

    it('falls back to a silent debug classification for unknown errors', () => {
        expect(describeDeviceError(HOST, new Error('boom'), withKey)).toEqual({
            kind: 'other',
            terminal: false,
            warnOnce: false,
        });
        expect(describeDeviceError(HOST, 'not an error', withKey).kind).toBe('other');
    });
});

describe('isTerminalDeviceError', () => {
    it('accepts every latched class and rejects retryable ones', () => {
        expect(isTerminalDeviceError(new InvalidPasswordError(HOST))).toBe(true);
        expect(isTerminalDeviceError(new InvalidEncryptionKeyError())).toBe(true);
        expect(isTerminalDeviceError(new EncryptionRequiredError())).toBe(true);
        expect(isTerminalDeviceError(new EncryptionPlaintextError())).toBe(true);
        expect(isTerminalDeviceError(new InvalidEncryptionKeyFormatError())).toBe(true);

        expect(isTerminalDeviceError(new EncryptionHandshakeError('bad'))).toBe(false);
        expect(isTerminalDeviceError(new ConnectionHandshakeError('closed'))).toBe(false);
        expect(isTerminalDeviceError(new Error('boom'))).toBe(false);
        expect(isTerminalDeviceError('not an error')).toBe(false);
    });
});
