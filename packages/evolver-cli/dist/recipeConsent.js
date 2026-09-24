import { hub } from '@evomap/evolver-core';
import { loadEnvFileFromEnvOrThrow } from '@evomap/evolver-mcp';
export function runRecipeConsentCommand(args, env, io) {
    loadEnvFileFromEnvOrThrow(env);
    const directory = hub.recipeStateDirectory(env);
    if (args.length === 0 || (args.length === 1 && args[0] === '--status')) {
        io.log(JSON.stringify(hub.readRecipeSpendConsent(directory) ?? { version: 1, enabled: false, maxCredits: 0 }));
        return 0;
    }
    if (args.length === 1 && args[0] === '--disable') {
        io.log(JSON.stringify(hub.setRecipeSpendConsent(false, 0, directory)));
        return 0;
    }
    if (args.length !== 4 || args[0] !== '--enable' || args[1] !== '--max-credits' || args[3] !== '--acknowledge-paid-recipe-charges' || !args[2]?.trim()) {
        throw new Error('recipe consent: --status | --disable | --enable --max-credits <ceiling> --acknowledge-paid-recipe-charges. Only the user may opt in; ATP consent is separate.');
    }
    io.log(JSON.stringify(hub.setRecipeSpendConsent(true, Number(args[2]), directory)));
    return 0;
}