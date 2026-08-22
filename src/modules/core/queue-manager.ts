import { log, logError } from "../utils/logger";

/**
 * QueueManager handles operation queuing with retry and exponential backoff.
 *
 * Operations are prioritized: metadata before attachments.
 * Rate limiting is provider-specific and configured per-provider.
 */

export interface QueuedOperation {
  id: string;
  type: "metadata" | "attachment";
  priority: number; // Lower = higher priority
  execute: () => Promise<void>;
  retries: number;
  maxRetries: number;
  lastError?: string;
}

export class QueueManager {
  private queue: QueuedOperation[] = [];
  private isProcessing = false;
  private maxConcurrent = 3;
  private activeCount = 0;

  /** Add an operation to the queue */
  enqueue(op: Omit<QueuedOperation, "retries" | "maxRetries"> & { maxRetries?: number }) {
    this.queue.push({
      ...op,
      retries: 0,
      maxRetries: op.maxRetries ?? 3,
    });
    // Sort by priority (metadata before attachments)
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  /** Start processing the queue */
  async processAll(): Promise<{ succeeded: number; failed: number }> {
    if (this.isProcessing) {
      log("Queue already processing");
      return { succeeded: 0, failed: 0 };
    }

    this.isProcessing = true;
    let succeeded = 0;
    let failed = 0;

    while (this.queue.length > 0) {
      // Process up to maxConcurrent operations at once
      const batch = this.queue.splice(0, this.maxConcurrent);
      const results = await Promise.allSettled(
        batch.map((op) => this.executeWithRetry(op)),
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
          succeeded++;
        } else {
          failed++;
          const op = batch[i];
          logError(`Queue operation ${op.id} failed permanently`, (results[i] as PromiseRejectedResult).reason);
        }
      }
    }

    this.isProcessing = false;
    log(`Queue processed: ${succeeded} succeeded, ${failed} failed`);
    return { succeeded, failed };
  }

  /** Stop processing */
  stop() {
    this.isProcessing = false;
    this.queue = [];
  }

  /** Get queue length */
  get length(): number {
    return this.queue.length;
  }

  private async executeWithRetry(op: QueuedOperation): Promise<void> {
    while (op.retries <= op.maxRetries) {
      try {
        await op.execute();
        return;
      } catch (err) {
        op.retries++;
        op.lastError = err instanceof Error ? err.message : String(err);

        if (op.retries > op.maxRetries) {
          throw err;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s...
        const delay = Math.pow(2, op.retries - 1) * 1000;
        log(
          `Operation ${op.id} failed (attempt ${op.retries}/${op.maxRetries}), retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
