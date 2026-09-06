'use strict';

const path = require('path');

const PROXY_PATH_FLAGS = new Map([
  ['--home', 'home'],
  ['--store', 'store'],
  ['--settings', 'settings'],
  ['--env-file', 'envFile'],
]);

function optionValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === name) {
      const value = argv[index + 1];
      if (value === undefined || String(value).startsWith('-')) {
        throw new Error(name + ' requires a value');
      }
      return String(value);
    }
    if (arg.startsWith(name + '=')) {
      const value = arg.slice(name.length + 1);
      if (!value) throw new Error(name + ' requires a value');
      return value;
    }
  }
  return undefined;
}

function parseSetupHooksCliOptions(argv, env = process.env) {
  const platform = optionValue(argv, '--platform');
  const runtime = optionValue(argv, '--runtime');
  if (platform && runtime && platform !== runtime) {
    throw new Error(
      `conflicting --platform=${platform} and --runtime=${runtime}; pass one runtime identity`
    );
  }
  const rawRoot = optionValue(argv, '--root');
  const root = rawRoot === undefined ? undefined : rawRoot.trim();
  if (rawRoot !== undefined && !root) {
    throw new Error('--root requires a non-empty path');
  }
  return {
    platform: platform || runtime,
    root: root
      ? path.resolve(expandHomePath(root, env))
      : undefined,
    force: argv.includes('--force'),
    uninstall: argv.includes('--uninstall'),
    verify: argv.includes('--verify'),
    json: argv.includes('--json'),
  };
}

function expandHomePath(value, env = process.env) {
  if (value === '~') return env.HOME || require('os').homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(env.HOME || require('os').homedir(), value.slice(2));
  }
  return value;
}

function parseProxyCliPathOptions(argv, env = process.env) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    const key = PROXY_PATH_FLAGS.get(flag);
    if (!key) continue;

    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : argv[++index];
    if (!value || !String(value).trim() || (equalsIndex < 0 && String(value).startsWith('-'))) {
      throw new Error(flag + ' requires a path');
    }
    options[key] = path.resolve(expandHomePath(String(value).trim(), env));
  }
  return options;
}

function applyProxyCliPathOptions(options, env = process.env) {
  if (options.envFile) env.EVOLVER_ENV_FILE = options.envFile;
  if (options.home) {
    env.EVOMAP_DIR = options.home;
    env.EVOLVER_HOME = options.home;
    env.EVOMAP_HOME = options.home;
    env.EVOLVER_SETTINGS_DIR = options.home;
    env.EVOLVER_PROXY_STORE = path.join(options.home, 'mailbox');
    env.EVOLVER_PROXY_SETTINGS_FILE = path.join(options.home, 'settings.json');
    env.EVOMAP_PROXY_TRACE_FILE = path.join(options.home, 'proxy', 'traces', 'proxy-traces.jsonl');
  }
  if (options.store) env.EVOLVER_PROXY_STORE = options.store;
  if (options.settings) env.EVOLVER_PROXY_SETTINGS_FILE = options.settings;
  return options;
}

function prepareProxyCliEnvironment(argv, env = process.env, dotenv = require('dotenv')) {
  const options = parseProxyCliPathOptions(argv, env);
  let envFile = { loaded: false, error: null };
  const selectedEnvFile = options.envFile || env.EVOLVER_ENV_FILE;
  if (selectedEnvFile) {
    const resolvedEnvFile = path.resolve(expandHomePath(String(selectedEnvFile).trim(), env));
    env.EVOLVER_ENV_FILE = resolvedEnvFile;
    const result = dotenv.config({ path: resolvedEnvFile, processEnv: env });
    envFile = { loaded: !result.error, error: result.error || null };
  }
  applyProxyCliPathOptions(options, env);
  return { options, envFile };
}

module.exports = {
  applyProxyCliPathOptions,
  expandHomePath,
  parseSetupHooksCliOptions,
  parseProxyCliPathOptions,
  prepareProxyCliEnvironment,
};
