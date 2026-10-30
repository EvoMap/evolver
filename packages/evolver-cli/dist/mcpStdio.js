export async function runMcpStdioCommand(argv) {
    if (argv.length) {
        process.stderr.write('usage: evolver mcp-stdio\n');
        return 2;
    }
    const server = await import('@evomap/evolver-mcp/stdio');
    await server.stdioLifetime;
    return Number(process.exitCode ?? 0);
}