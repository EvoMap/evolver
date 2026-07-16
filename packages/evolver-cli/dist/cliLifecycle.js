export async function settleCliProcess(run, proc = process) {
    try {
        proc.exitCode = await run();
    }
    catch (error) {
        proc.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        proc.exitCode = 1;
    }
}