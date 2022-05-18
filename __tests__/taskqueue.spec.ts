import { Task, TaskQueue, ConsoleSubscriber, QueueError, TaskError } from '../src';
import { AbortController, AbortSignal } from 'node-abort-controller';

const delay = (title: string, ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    return Promise.reject(new Error(`Aborted`));
  }
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(title), ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error(`Aborted`));
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
    }
  });
};

const createAsyncTask = (title: string, ms: number): Task<string> => {
  const task: Task<string> = ({ signal }) => delay(title, ms, signal);
  task.title = title;
  return task;
};

const createSyncTask = (title: string): Task => {
  const task: Task = () => title;
  task.title = title;
  return task;
};

describe('TaskQueue', () => {
  it('should create de TaskQueue', () => {
    const queue = new TaskQueue();

    expect(queue).toBeInstanceOf(TaskQueue);
  });

  it('should enqueue tasks', async () => {
    const queue = new TaskQueue();
    const t1 = jest.fn();

    queue.push(t1, t1);
    const size = queue.push(t1);

    expect(size).toBe(3);
  });

  it('should run all sync task', async () => {
    const queue = new TaskQueue();
    const t1 = jest.fn();

    queue.push(t1, t1, t1);
    await queue.run();

    expect(t1).toHaveBeenCalledTimes(3);
  });

  it('should run empty queue', async () => {
    const queue = new TaskQueue();

    await expect(queue.run()).resolves.toEqual([]);
  });

  it('should reject with invalid concurrency', async () => {
    const queue = new TaskQueue();
    const t1 = jest.fn();

    queue.push(t1, t1, t1);
    await expect(queue.run({ concurrency: -1 })).rejects.toEqual(new Error('Invalid concurrency'));
  });

  it('should convert to Task', async () => {
    const outer = new TaskQueue();
    const inner = new TaskQueue();

    const t1 = jest.fn();
    inner.push(t1, t1, t1);
    outer.push(inner.toTask());

    outer.run();
    expect(t1).toHaveBeenCalledTimes(3);
  });

  it('should run all async tasks', async () => {
    const queue = new TaskQueue<string>();
    const t1 = createAsyncTask('t1', 10);
    const t2 = createAsyncTask('t2', 50);
    const t3 = createAsyncTask('t3', 20);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskCompleted', ({ task }) => events.push(`complete-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);
    const res = await queue.run();

    expect(res).toEqual(['t1', 't3', 't2']);
    expect(events).toEqual([
      'start',
      'start-t1',
      'start-t2',
      'start-t3',
      'complete-t1',
      'complete-t3',
      'complete-t2',
      'complete',
    ]);
  });

  it('should run all async tasks with concurrency', async () => {
    const queue = new TaskQueue();
    const t1 = createAsyncTask('t1', 10);
    const t2 = createAsyncTask('t2', 50);
    const t3 = createAsyncTask('t3', 20);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskCompleted', ({ task }) => events.push(`complete-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);
    const res = await queue.run({ concurrency: 2 });

    expect(res).toEqual(['t1', 't3', 't2']);
    expect(events).toEqual([
      'start',
      'start-t1',
      'start-t2',
      'complete-t1',
      'start-t3',
      'complete-t3',
      'complete-t2',
      'complete',
    ]);
  });

  it('should be able to combine sync/async tasks', async () => {
    const queue = new TaskQueue();
    const t1 = createAsyncTask('t1', 10);
    const t2 = createSyncTask('t2');
    const t3 = createAsyncTask('t3', 10);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskCompleted', ({ task }) => events.push(`complete-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);
    const res = await queue.run({ concurrency: 2 });

    expect(res).toEqual(['t2', 't1', 't3']);
    expect(events).toEqual([
      'start',
      'start-t1',
      'start-t2',
      'complete-t2',
      'start-t3',
      'complete-t1',
      'complete-t3',
      'complete',
    ]);
  });

  it('should manage errors silently', async () => {
    const queue = new TaskQueue();

    const t1 = jest.fn().mockResolvedValue('t1');
    const t2 = jest.fn().mockRejectedValue(new Error('bum'));
    const t3 = jest.fn().mockResolvedValue('t3');

    queue.push(t1, t2, t3);
    let messages: string[] = [];
    let error = null;

    try {
      await queue.run();
    } catch (err) {
      messages = err.message.split('\n');
      error = err;
    }
    expect(messages[0]?.trim()).toEqual('TaskQueue ended with 1 errors:');
    expect(messages[1]?.trim()).toContain('bum');
    expect(error).toBeInstanceOf(QueueError);
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toBeInstanceOf(TaskError);
    expect(error.errors[0].message).toMatch('bum');
    expect(error.errors[0].cause).toBeInstanceOf(Error);
    expect(error.errors[0].cause.message).toMatch('bum');
  });

  it('should receive results/erros on complete', async () => {
    expect.assertions(3);

    const queue = new TaskQueue();
    const t1 = jest.fn().mockResolvedValue('t1');
    const t2 = jest.fn().mockRejectedValue(new Error('bum'));
    const t3 = jest.fn().mockResolvedValue('t3');

    queue.once('complete', ({ errors, results }) => {
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch('bum');
      expect(results).toEqual(['t1', 't3']);
    });

    queue.push(t1, t2, t3);
    try {
      await queue.run({ concurrency: 2 });
    } catch (err) {
      void 0;
    }
  });

  it('should cancel the queue on timeout', async () => {
    const queue = new TaskQueue();

    const t1 = createAsyncTask('t1', 10);
    const t2 = createAsyncTask('t2', 50);
    const t3 = createAsyncTask('t3', 20);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskError', ({ task }) => events.push(`error-${task.title}`));
    queue.on('taskSuccess', ({ task }) => events.push(`success-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);

    let messages: string[] = [];
    let error = null;

    try {
      await queue.run({ timeout: 20, concurrency: 2 });
    } catch (err) {
      messages = err.message.split('\n');
      error = err;
    }

    expect(events).toEqual([
      'start',
      'start-t1',
      'start-t2',
      'success-t1',
      'start-t3',
      'error-t2',
      'error-t3',
      'complete',
    ]);
    expect(messages[0]?.trim()).toEqual('TaskQueue ended with 3 errors:');
    expect(error).toBeInstanceOf(QueueError);
    expect(error.errors).toHaveLength(3);
    expect(error.errors[0].message).toMatch('Queue Timeout');
    expect(error.errors[1].message).toMatch('t2: Aborted');
    expect(error.errors[2].message).toMatch('t3: Aborted');
  });

  it('should cancel the queue on signal', async () => {
    const queue = new TaskQueue();

    const t1 = createAsyncTask('t1', 10);
    const t2 = createAsyncTask('t2', 50);
    const t3 = createAsyncTask('t3', 20);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskError', ({ task }) => events.push(`error-${task.title}`));
    queue.on('taskSuccess', ({ task }) => events.push(`success-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);

    let messages: string[] = [];
    let error = null;

    const controller = new AbortController();
    const signal = controller.signal;

    try {
      setTimeout(() => controller.abort(), 20);
      await queue.run({ concurrency: 2, signal });
    } catch (err) {
      messages = err.message.split('\n');
      error = err;
    }

    expect(events).toEqual([
      'start',
      'start-t1',
      'start-t2',
      'success-t1',
      'start-t3',
      'error-t2',
      'error-t3',
      'complete',
    ]);
    expect(messages[0]?.trim()).toEqual('TaskQueue ended with 3 errors:');
    expect(error).toBeInstanceOf(QueueError);
    expect(error.errors).toHaveLength(3);
    expect(error.errors[0].message).toMatch('Queue Aborted');
    expect(error.errors[1].message).toMatch('t2: Aborted');
    expect(error.errors[2].message).toMatch('t3: Aborted');
  });

  it('should repeat the queue until signal', async () => {
    const queue = new TaskQueue();

    const t1 = createAsyncTask('t1', 50);
    const t2 = createAsyncTask('t2', 50);
    const t3 = createAsyncTask('t3', 50);

    const events: string[] = [];
    queue.on('start', () => events.push(`start`));
    queue.on('taskStart', ({ task }) => events.push(`start-${task.title}`));
    queue.on('taskError', ({ task }) => events.push(`error-${task.title}`));
    queue.on('taskSuccess', ({ task }) => events.push(`success-${task.title}`));
    queue.on('complete', () => events.push(`complete`));

    queue.push(t1, t2, t3);

    const controller = new AbortController();
    const signal = controller.signal;

    setTimeout(() => controller.abort(), 75);
    await queue.every(10, { signal });

    expect(events).toEqual([
      // first iteration in the firsts 50 ms
      'start',
      'start-t1',
      'start-t2',
      'start-t3',
      'success-t1',
      'success-t2',
      'success-t3',
      'complete',

      // second iteration. Cancelled by signal
      'start',
      'start-t1',
      'start-t2',
      'start-t3',
      'error-t1',
      'error-t2',
      'error-t3',
      'complete',
    ]);
  });

  it('should subscribe to events and print to console', async () => {
    // TODO: think in a way with jest to no have flacky tests
    console.info = jest.fn();
    console.debug = jest.fn();
    console.error = jest.fn();

    const queue = new TaskQueue('Plo');
    const unsubscribe = ConsoleSubscriber(queue, true);

    const t1 = createSyncTask('with_title');
    const t2 = () => void 0;
    function t3() {
      void 0;
    }
    function t4() {
      throw new Error('bum');
    }

    queue.push(t1, t2, t3, t4);

    try {
      await queue.run();
    } catch (err) {
      void 0;
    }

    expect(console.info).toHaveBeenNthCalledWith(1, '[ START  ] Plo with 4 task (4 in parallel)');
    //  expect(console.info).toHaveBeenNthCalledWith(2, '[COMPLETE] Plo completed in 0ms'); // flacky
    expect(console.debug).toHaveBeenNthCalledWith(1, '[ BEGIN  ] Plo: with_title');
    expect(console.debug).toHaveBeenNthCalledWith(2, '[ BEGIN  ] Plo: t2');
    expect(console.debug).toHaveBeenNthCalledWith(3, '[ BEGIN  ] Plo: t3');
    unsubscribe();
  });
});
