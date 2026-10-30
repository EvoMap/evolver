export function proxyStopSignal(source = process) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    source.on('SIGINT', stop);
    source.on('SIGTERM', stop);
    return {
        signal: controller.signal,
        close() {
            source.off('SIGINT', stop);
            source.off('SIGTERM', stop);
        },
    };
}