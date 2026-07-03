#!/usr/bin/env node
import { dispatch } from './dispatch.js';
const argv = process.argv.slice(2);
const fail = (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); };
// Single dispatch path (registry in dispatch.ts): async handler if the verb is registered, else the runCli core.
// Promise.resolve normalizes the sync (runCli → number) and async (handler → Promise<number>) branches to one exit.
Promise.resolve(dispatch(argv)).then((code) => process.exit(code)).catch(fail);