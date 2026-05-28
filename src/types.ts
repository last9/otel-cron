export interface CronJobOptions {
  /** Unique job name used as faas.name attribute and metric label */
  name: string;
  /** Cron expression (informational, emitted as faas.cron attribute) */
  cron: string;
  /** Timeout in milliseconds. On breach, FaaSTimeoutError is thrown but fn() continues running. */
  timeout?: number;
}

export class FaaSTimeoutError extends Error {
  constructor(jobName: string, timeoutMs: number) {
    super(`Cron job "${jobName}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'FaaSTimeoutError';
  }
}
