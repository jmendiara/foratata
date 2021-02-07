import { EventEmitter } from 'events';
import AbortController from 'node-abort-controller';

/**
 * Simple Task Queue to make notificable concurrent tasks, with continue-on-failure
 *
 * notifies about the queue lifecycle with the events: `start`, `complete`,
 * and the tasks lifecycle with `taskStart`, `taskSuccess`, `taskError`, `taskEnd`
 */
export class TaskQueue<RESULT = unknown> extends EventEmitter {
  /** the queue */
  protected queue: Task<RESULT>[] = [];
  protected pending: Task<RESULT>[] = [];
  private errors: Error[] = [];
  private results: RESULT[] = [];
  private running = 0;
  private runStart = 0;
  private controller: AbortController;

  constructor(public title = 'TaskQueue', public options: QueueOptions = {}) {
    super();
  }

  private complete() {
    const event: QueueCompleteEvent = {
      time: Date.now() - this.runStart,
      results: this.results,
      errors: this.errors.length !== 0 ? this.errors : undefined,
    };

    this.runStart = 0;
    this.emit('complete', event);
    this.removeAllListeners();
  }

  /** consumes the queue runnin tasks */
  private async runTask(task: Task<RESULT>) {
    this.running++;
    const start = Date.now();
    const signal = this.controller.signal;
    try {
      this.emit('taskStart', { task });
      const result = await task({ signal });
      this.emit('taskSuccess', { task, time: Date.now() - start, result });
      this.results.push(result);
    } catch (error) {
      // store and forget
      this.emit('taskError', { error, task, time: Date.now() - start });
      const err = new TaskError(`${task.title ?? task.name}: ${error?.message ?? error}`, error);
      this.errors.push(err);
    }
    this.emit('taskCompleted', { task, time: Date.now() - start });
    this.running--;

    // aborting does efectivelly complete the queue
    if (!signal.aborted) {
      const arePendingTasks = this.pending.length > 0;
      const isExecutionCompleted = this.running === 0;
      if (arePendingTasks) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.runTask(this.pending.shift());
      } else if (isExecutionCompleted) {
        this.complete();
      }
    }
  }

  /**
   * Adds a task to the queue
   *
   * @param task The task to run
   * @returns the new length of the queue.
   */
  public push(...task: Task<RESULT>[]): number {
    return this.queue.push(...task);
  }

  /**
   * Converts the queue to a Task to anidate queues
   *
   * @example
   * ```js
   * const outerQueue = new TaskQueue();
   * const innerQueue = new TaskQueue();
   *
   * outerQueue.push(innerQueue.toTask());
   *
   * outerQueue.run();
   *
   * ```
   */
  public toTask(options: QueueOptions = {}): Task<RESULT[]> {
    const task: Task<RESULT[]> = () => this.run(options);
    task.title = this.title;
    return task;
  }

  /**
   * Runs the queue.
   *
   * A failing task does not end the execution, but is stored to late notification.
   *
   * Rejects with a simple error with a message with an error abstract. For more detailed errors, you can subscribe
   * to `complete` event.
   */
  public async run(options: QueueOptions = {}): Promise<RESULT[]> {
    const concurrency = options.concurrency ?? this.options.concurrency ?? this.queue.length;
    const timeoutMs = options.timeout ?? this.options.timeout;
    if ((concurrency as number) <= 0 && this.queue.length !== 0) {
      throw new Error('Invalid concurrency');
    }

    this.runStart = Date.now();
    this.controller = new AbortController();

    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout;

      this.once('complete', ({ errors }) => {
        clearTimeout(timeout);
        // Schedule resolving after I/O to allow Aborted Tasks to process the cancellation
        setImmediate(() => {
          if (errors) {
            const msgs = [
              `${this.title} ended with ${errors.length} errors:`,
              ...errors.map((err: Error) => err.message),
            ];
            reject(new QueueError(msgs.join('\n  '), errors));
          } else {
            resolve(this.results);
          }
        });
      });

      this.emit('start', { concurrency, size: this.queue.length });
      if (this.queue.length === 0) {
        this.complete();
      }

      if (timeoutMs) {
        timeout = setTimeout(() => {
          this.controller.abort();
          this.errors.unshift(new Error('Queue Timeout'));
          this.complete();
        }, timeoutMs);
      }
      // Copy queue to allow rehuse
      this.pending = this.queue;
      this.pending.splice(0, concurrency).forEach((task) => this.runTask(task));
    });
  }
}

/**
 * Uses console to print queue lifecycle messages
 *
 * @param queue The queue to print progress
 * @param verbose log every task start/stop
 * @returns a method to unsubscribe the events and stop login
 */
export const ConsoleSubscriber = (queue: TaskQueue, verbose = false): (() => void) => {
  const timestring = (time: number) => `${String(time).padStart(6)}ms`;
  const title = (task: Task) => `${queue.title}: ${task.title ?? task.name ?? 'task'}`;
  const onTaskStart = ({ task }: TaskStartEvent) => console.debug(`[ BEGIN  ] ${title(task)}`);
  const onTaskCompleted = ({ task, time }: TaskEvent) => console.debug(`[${timestring(time)}] END ${title(task)}`);
  const onTaskSuccess = ({ task, time }: TaskSuccessEvent) => console.debug(`[${timestring(time)}] OK ${title(task)}`);
  const onTaskError = ({ task, time }: TaskErrorEvent) => console.error(`[${timestring(time)}] KO ${title(task)}`);
  const onStart = ({ concurrency, size }: QueueStartEvent) =>
    console.info(`[ START  ] ${queue.title} with ${size} task (${concurrency} in parallel)`);
  const onComplete = ({ time }: QueueCompleteEvent) => console.info(`[COMPLETE] ${queue.title} completed in ${time}ms`);

  const subscribe = () => {
    if (verbose) {
      queue.on('taskStart', onTaskStart);
      queue.on('taskCompleted', onTaskCompleted);
    }
    queue.on('taskSuccess', onTaskSuccess);
    queue.on('taskError', onTaskError);
    queue.once('start', onStart);
    queue.once('complete', onComplete);
    queue.once('complete', unsubscribe);
  };

  const unsubscribe = () => {
    queue.off('taskStart', onTaskStart);
    queue.off('taskCompleted', onTaskCompleted);
    queue.off('taskSuccess', onTaskSuccess);
    queue.off('taskError', onTaskError);
    queue.off('start', onStart);
    queue.off('complete', onComplete);
  };

  subscribe();
  return unsubscribe;
};

export interface TaskQueue {
  on(event: 'taskStart', listener: (ev: TaskStartEvent) => void): this;
  on(event: 'taskSuccess', listener: (ev: TaskSuccessEvent) => void): this;
  on(event: 'taskError', listener: (ev: TaskErrorEvent) => void): this;
  on(event: 'taskCompleted', listener: (ev: TaskEvent) => void): this;
  on(event: 'start', listener: (ev: QueueStartEvent) => void): this;
  on(event: 'complete', listener: (ev: QueueCompleteEvent) => void): this;
}

/**
 * Options for running a queue
 */
export interface QueueOptions {
  /** the concurrency to execute tasks. Not providing this parameter will run all the tasks in parallel */
  concurrency?: number;
  /** max time in ms allowed to run the queue. If it's not done in the provided time, will cancel the pending tasks and fail the queue execution */
  timeout?: number;
}

/**
 * Options for running a task
 */
export interface TaskOptions {
  /** AbortSignal signaling the Queue execution is cancelled. See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal */
  signal: AbortSignal;
}

/**
 * Asyncronous execution task
 */
export interface Task<RESULT = unknown> {
  /** async / sync function executing a task */
  (opts: TaskOptions): Promise<RESULT> | RESULT;
  /** optional title for the task. Good to set for better trazability */
  title?: string;
}

/**
 * Emmited when a task has ended, successfully or not
 */
export interface TaskEvent<RESULT = unknown> {
  /** the task executed */
  task: Task<RESULT>;
  /** time (in ms) the task took to complete */
  time: number;
}

/**
 * Emmited when a task starts, successfully or not
 */
export interface TaskStartEvent<RESULT = unknown> {
  /** the task executed */
  task: Task<RESULT>;
}

/**
 * Emmited when a task succeeds
 */
export interface TaskSuccessEvent<RESULT = unknown> extends TaskEvent {
  /** the error thrown */
  result: RESULT;
}

/**
 * Emmited when a task erroes
 */
export interface TaskErrorEvent extends TaskEvent {
  /** the error thrown */
  error: Error;
}

/**
 * Emmited when the queue completes
 */
export interface QueueCompleteEvent<RESULT = unknown> {
  /** results for the succesfull tasks */
  results: RESULT[];
  /** errors raised during the execution */
  errors?: Error[];
  /** time (in ms) the queue took to complete */
  time: number;
}

/**
 * Emmited when the queue starts
 */
export interface QueueStartEvent {
  /** The concurrency used for running the queue */
  concurrency: number;
  /** number of tasks in the queue */
  size: number;
}

/**
 * Run Queue with all the errors and the abstract message for all of them
 */
export class QueueError extends Error {
  constructor(message: string, public errors: TaskError[]) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TaskError extends Error {
  constructor(message: string, public cause: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
