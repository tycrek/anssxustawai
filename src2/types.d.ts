declare module 'ass' {

    /**
     * Core Express server config.
     * This is separate from the user configuration starting in 0.15.0
     */
    interface ServerConfiguration {
        host: string,
        port: number,
        proxied: boolean
    }

    interface UserConfiguration {
        idType: string;
    }
}

//#region Dummy modules
declare module '@tinycreek/postcss-font-magician';
//#endregion
