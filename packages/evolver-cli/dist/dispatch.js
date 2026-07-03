// The CLI command registry — the single source of truth for which verbs `evolver <verb>` resolves to.
// `cli.ts` is the executable shim (it reads process.argv at import time, so it must NOT be imported by tests);
// this module holds the dispatch DATA so the surface is importable and assertable (see commandSurface.test.ts).
// The "phantom command" trap this guards against: an installer baking `evolver <verb>` into a user's runtime
// config for a verb the CLI never actually dispatches — a green build hides it, the user hits a usage error.
import { runCli, runMigrate, runAssetLog, runDistill, runIngest, runInject, runReview, } from './index.js';
import { runAutoExec } from './autoexec.js';
import { runAtpCommand, runBuyCommand, runOrdersCommand, runVerifyCommand } from './atp.js';
import { runLogin } from './login.js';
import { runSetupHooks } from './setupHooks.js';
import { runSkillDistill, runSkillMdUpdate } from './skillDistill.js';
import { runThesisCommand } from './thesis.js';
import { getCliVersion } from './version.js';
import { runRecipeCommand } from './recipe.js';
import { runReuseCommand } from './reuse.js';
import { runPublishCommand } from './cliContracts.js';
import { runRecallCommand } from './recall.js';
import { runReuseReportCommand } from './reuseReport.js';
import { runDoctorCommand } from './doctor.js';
import { runPhubCommand } from './phub.js';
import { runTrajectoryExport } from './trajectoryExport.js';
import { runAntiGeneBenchmarkCommand } from './antiGeneBenchmark.js';
import { runAntiGeneRolloutCommand } from './antiGeneRollout.js';
import { runLifecycleCommand } from './lifecycle.js';
import { runCycleCommand } from './cycleConsumer.js';
/** Verbs dispatched asynchronously ahead of the synchronous runCli core. cli.ts drives its dispatch from this. */
export const ASYNC_COMMANDS = {
    migrate: runMigrate,
    'asset-log': runAssetLog,
    distill: runDistill,
    ingest: runIngest,
    inject: runInject,
    review: runReview,
    'skill-distill': runSkillDistill,
    'skill-md-update': runSkillMdUpdate,
    thesis: runThesisCommand,
    autoexec: runAutoExec,
    login: runLogin,
    'setup-hooks': runSetupHooks,
    buy: runBuyCommand,
    orders: runOrdersCommand,
    verify: runVerifyCommand,
    atp: runAtpCommand,
    recipe: runRecipeCommand,
    reuse: runReuseCommand,
    publish: runPublishCommand,
    recall: runRecallCommand,
    'reuse-report': runReuseReportCommand,
    doctor: runDoctorCommand,
    phub: runPhubCommand,
    lifecycle: runLifecycleCommand,
    cycle: runCycleCommand,
    'trajectory-export': runTrajectoryExport,
    'anti-gene-benchmark': runAntiGeneBenchmarkCommand,
    'anti-gene-rollout': runAntiGeneRolloutCommand,
};
/** Verbs handled by the synchronous runCli core (read-only views + local ops). Kept in sync with runCli's switch
 *  — the source of truth for these stays runCli; this list completes the surface for the registry contract. */
export const SYNC_COMMANDS = [
    'status', 'cycles', 'trigger', 'value', 'narrative', 'retention', 'gene-value', 'replay', 'rebuild-views', 'reset-local-secret',
];
/** Every top-level verb `evolver` resolves to (async-dispatched ∪ runCli core). */
export const ALL_COMMANDS = new Set([
    ...Object.keys(ASYNC_COMMANDS),
    ...SYNC_COMMANDS,
]);
/** Run a top-level argv against the registry: async handler if present, else the synchronous runCli core. */
export function dispatch(argv) {
    if (argv[0] === '--version' || argv[0] === '-v') {
        process.stdout.write(`${getCliVersion()}\n`);
        return 0;
    }
    const handler = ASYNC_COMMANDS[argv[0] ?? ''];
    return handler ? handler(argv.slice(1)) : runCli(argv);
}