import { EventEmitter } from 'events';

/**
 * Simple Task Queue to make notificable concurrent tasks, with continue-on-failure
 *
 * notifies about the queue lifecycle with the events: `start`, `complete`,
 * and the tasks lifecycle with `taskStart`, `taskSuccess`, `taskError`, `taskEnd`
 */
export class TaskQueue extends EventEmitter {
  /** the queue */
  protected queue: Task[] = [];
  protected pending: Task[] = [];
  private errors: Error[] = [];
  private running = 0;
  private runStart = 0;

  constructor(public title = 'TaskQueue', public concurrency?: number) {
    super();
  }

  private complete() {
    const event: QueueCompleteEvent = {
      time: Date.now() - this.runStart,
    };
    if (this.errors.length !== 0) {
      event.errors = this.errors;
    }
    this.runStart = 0;
    this.emit('complete', event);
    this.removeAllListeners();
  }

  /** consumes the queue runnin tasks */
  private async runTask(task: Task) {
    this.running++;
    const start = Date.now();
    try {
      this.emit('taskStart', { task });
      await task();
      this.emit('taskSuccess', { task, time: Date.now() - start });
    } catch (error) {
      // store and forget
      this.emit('taskError', { error, task, time: Date.now() - start });
      const err = new Error(`${task.title ?? task.name}: ${error?.message ?? error}`);
      this.errors.push(err);
    }
    this.emit('taskCompleted', { task, time: Date.now() - start });
    this.running--;

    const arePendingTasks = this.pending.length > 0;
    if (arePendingTasks) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.runTask(this.pending.shift());
    } else if (this.running === 0) {
      this.complete();
    }
  }

  /**
   * Adds a task to the queue
   *
   * @param task The task to run
   * @returns the new length of the queue.
   */
  public push(...task: Task[]): number {
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
   * @param concurrency
   */
  public toTask(concurrency?: number): Task {
    const task: Task = () => this.run(concurrency);
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
   *
   * @param concurrency the concurrency to execute task. Not providing this parameter will run all the tasks in parallel
   */
  public async run(concurrency?: number): Promise<void> {
    concurrency = concurrency ?? this.concurrency ?? this.queue.length;
    if ((concurrency as number) <= 0 && this.queue.length !== 0) {
      throw new Error('Invalid concurrency');
    }

    this.runStart = Date.now();

    return new Promise((resolve, reject) => {
      this.once('complete', ({ errors }) => {
        if (errors) {
          const msgs = [
            `${this.title} ended with ${errors.length} errors:`,
            ...errors.map((err: Error) => err.message),
          ];
          reject(new Error(msgs.join('\n  ')));
        } else {
          resolve();
        }
      });

      this.emit('start', { concurrency, size: this.queue.length });
      if (this.queue.length === 0) {
        this.complete();
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
  const onTaskSuccess = ({ task, time }: TaskEvent) => console.debug(`[${timestring(time)}] OK ${title(task)}`);
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
  on(event: 'taskSuccess', listener: (ev: TaskEvent) => void): this;
  on(event: 'taskError', listener: (ev: TaskErrorEvent) => void): this;
  on(event: 'taskCompleted', listener: (ev: TaskEvent) => void): this;
  on(event: 'start', listener: (ev: QueueStartEvent) => void): this;
  on(event: 'complete', listener: (ev: QueueCompleteEvent) => void): this;
}

/**
 * Asyncronous execution task
 */
export interface Task {
  /** async function executing a task */
  (): Promise<unknown> | unknown;
  /** optional title for the task. Good to set for better trazability */
  title?: string;
}

/**
 * Emmited when a task has ended, successfully or not
 */
interface TaskEvent {
  /** the task executed */
  task: Task;
  /** time (in ms) the task took to complete */
  time: number;
}

/**
 * Emmited when a task starts, successfully or not
 */
interface TaskStartEvent {
  /** the task executed */
  task: Task;
}

/**
 * Emmited when a task erroes
 */
interface TaskErrorEvent {
  /** the task executed */
  task: Task;
  /** time (in ms) the task took to complete */
  time: number;
  /** the error thrown */
  error: unknown;
}

/**
 * Emmited when the queue completes
 */
interface QueueCompleteEvent {
  /** errors raised during the execution */
  errors?: Error[];
  /** time (in ms) the queue took to complete */
  time: number;
}

/**
 * Emmited when the queue starts
 */
interface QueueStartEvent {
  /** The concurrency used for running the queue */
  concurrency: number;
  /** number of tasks in the queue */
  size: number;
}
