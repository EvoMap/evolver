#!/usr/bin/env node
import { dispatch } from '@evomap/evolver-cli/dispatch';
const fail = (err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); };
Promise.resolve(dispatch(process.argv.slice(2))).then((code) => process.exit(code)).catch(fail);
