// lib/harness/dsh/plugin-record.js — the DSH log's plugin-record namespace: the one place a record's type is made of its name, for the writers (`dsh/src/inner-seal.js`, `dsh/src/inner-mode.js`) and for the reader of the Source (`recall-facts.js`).

/**
 * The type the DSH log gives the plugin record of a name.
 * @param {string} name
 * @returns {string}
 */
export const pluginRecordType = name => `plugin:session-watcher/${name}`;
