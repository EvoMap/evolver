#!/usr/bin/env node
import { dispatch } from '@evomap/evolver-cli/dispatch';
const flush = (stream) => new Promise((resolve) => { try { stream.write('', (error) => resolve(Boolean(error))); } catch { resolve(true); } });
const exit = async (code) => { const failures = await Promise.all([flush(process.stdout), flush(process.stderr)]); process.exit(failures.some(Boolean) ? 1 : code); };
const fail = async (err) => { try { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); } finally { await exit(1); } };
void (async () => { try { await exit(await dispatch(process.argv.slice(2))); } catch (err) { await fail(err); } })();
