import { type InstallResult, type InstallerTransactionSummary } from '@evomap/evolver-mcp';
import { type SetupLifecycleAction, type SetupLifecycleContext, type SetupLifecyclePlan, type SetupLifecycleExecutionOptions, type SetupLifecycleExecutionResult } from './setupHooksLifecycle.js';
export interface SetupLifecycleDriver {
    intent(context: SetupLifecycleContext, action: SetupLifecycleAction): string;
    plan(context: SetupLifecycleContext, action: SetupLifecycleAction, createdAt: Date, expiresAt: Date, paths?: Map<string, string>): SetupLifecyclePlan;
    preview(context: SetupLifecycleContext, action: SetupLifecycleAction): InstallResult;
    apply(context: SetupLifecycleContext, action: SetupLifecycleAction, path?: string): InstallResult;
    verify(context: SetupLifecycleContext): boolean;
}
export declare function executeSetupTransaction(context: SetupLifecycleContext, confirmed: SetupLifecyclePlan, options: SetupLifecycleExecutionOptions, driver: SetupLifecycleDriver): SetupLifecycleExecutionResult;
export declare function inspectSetupTransactions(context: SetupLifecycleContext, id?: string): InstallerTransactionSummary[];
export declare function recoverSetupTransaction(context: SetupLifecycleContext, id: string, recovery: 'resume' | 'rollback' | 'accept-current', driver: SetupLifecycleDriver, confirmedState?: string): InstallerTransactionSummary | SetupLifecycleExecutionResult;