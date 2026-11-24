import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The config UI masks a field only when the form layout says so; Homebridge's
 * secret-name regex does not recognise `encryptionKey`. Guard the schema shape so a
 * refactor cannot silently expose the key.
 */
const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
    schema: {
        properties: {
            devices: {
                items: {
                    properties: Record<string, { type?: string; default?: unknown }>;
                };
            };
        };
    };
    form: Array<{ items: Array<unknown> }>;
};

const deviceProperties = schema.schema.properties.devices.items.properties;
const deviceFormItems = (schema.form[0].items[0] as { items: Array<string | { key: string; type?: string }> }).items;

describe('config schema', () => {
    it('declares the encryptionKey as an optional string without a default', () => {
        expect(deviceProperties.encryptionKey).toMatchObject({ type: 'string' });
        expect(deviceProperties.encryptionKey).not.toHaveProperty('default');
    });

    it('masks the encryptionKey in the config form', () => {
        expect(deviceFormItems).toContainEqual({ key: 'devices[].encryptionKey', type: 'password' });
    });

    it('declares and renders invertFanDirection as a boolean', () => {
        expect(deviceProperties.invertFanDirection).toMatchObject({ type: 'boolean' });
        expect(deviceFormItems).toContain('devices[].invertFanDirection');
    });
});
