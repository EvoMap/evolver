import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Envelope } from './envelope.js';
import type { MailboxStore } from './store.js';
export interface IpcServerOptions {
    store: MailboxStore;
    token: string;
    host?: string;
    now?: () => number;
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
    private readonly extraRoutes;
    private readonly onSend;
    private readonly onAuthFailure;
    constructor(opts: IpcServerOptions);
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
    private handle;
    private readJson;
    private json;
}