#!/usr/bin/env node
import { runProxyCli } from '@evomap/evolver-proxy/bin/evolver-proxy';
const fail = () => { process.stderr.write('[evolver-proxy] fatal: proxy runner rejected\n'); process.exitCode = 1; };
void runProxyCli().then((code) => { process.exitCode = code; }).catch(fail);
