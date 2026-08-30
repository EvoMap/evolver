import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Envelope } from './envelope.js';
import { type MailboxStore } from './store.js';
export interface IpcServerOptions {
    store: MailboxStore;
    token: string;
    host?: string;
    now?: () => number;
    /** When set, every mailbox route is pinned to this daemon namespace. */
    runtimeNamespace?: string;
    extraRoutes?: IpcRouteHandler[];
    onSend?: (envelope: Envelope, result: {
        receiptId: string;
        stored: boolean;
    }) => void;
    onAuthFailure?: () => void;
}
export interface IpcRouteContext {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    route: string;
    now: number;
    store: MailboxStore;
    /** 请求连接中止或响应提前关闭时触发；长任务应将其传给可取消的宿主执行器。 */
    signal?: AbortSignal;
    readJson: () => Promise<unknown>;
    json: (code: number, body: unknown) => void;
}
export type IpcRouteHandler = (ctx: IpcRouteContext) => boolean | void | Promise<boolean | void>;
/**
 * 本地 HTTP IPC(M2-6): runtime adapter ↔ mailbox 的进程间通道.
 * 仅绑 127.0.0.1 + Bearer token; runtimeNamespace 分区, 不同 runtime 实例互不串信箱.
 */
export declare class MailboxIpcServer {
    private readonly server;
    private readonly store;
    private readonly token;
    private readonly host;
    private readonly now;
    private readonly runtimeNamespace;
    private readonly extraRoutes;
    private readonly onSend;
    private readonly onAuthFailure;
    constructor(opts: IpcServerOptions);
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
    private handle;
    private readJson;
    private resolveSendNamespace;
    private resolveRuntimeNamespace;
    private messageInRuntime;
    private canMutateMessage;
    private json;
}
export declare function legacyMailboxMessage(message: Envelope): Record<string, unknown>;