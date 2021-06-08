export const isRecord = (arg: unknown): arg is Record<string, unknown> =>
    !!arg && typeof arg === 'object' && !Array.isArray(arg);
