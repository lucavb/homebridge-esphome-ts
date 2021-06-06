declare module 'bonjour-hap' {
    export type BonjourFindOptions = {};

    export type BonjourService = {
        name: string;
        host: string;
        port?: number;
        addresses: string[];
    };

    export class Browser {
        stop(): void;
    }

    export default class Bonjour {
        find(options: BonjourFindOptions, onUp: (service: BonjourService) => void): Browser;
    }
}
