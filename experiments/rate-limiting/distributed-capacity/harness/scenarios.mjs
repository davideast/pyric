import { readdirSync } from 'node:fs';
const directory = new URL('../scenarios/', import.meta.url);
export const scenarios = Object.fromEntries(await Promise.all(readdirSync(directory).filter(name => name.endsWith('.mjs')).sort().map(async name => [name.slice(0, -4), await import(new URL(name, directory).href)])));
