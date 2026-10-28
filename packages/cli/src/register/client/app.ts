/**
 * `firebase/app` in a Node process `@pyric/cli/register` activated against a
 * remote host (#1082): the exact Pyric client registry, bound by the bootstrap
 * to no sandbox. The served service modules beside this one reach the Node
 * host through each app's own hosted connection.
 */
import './bootstrap.js';

export * from 'pyric/app';
export * from '../../serve/entries/unsupported/app.js';
