
# foratata

Concurrent TaskQueue with lifecycle notification in typescript (alike a Promise.map with concurrency and continue on failure)

NodeJS only (if somebody interested on browser, please open issue)

## Getting Started
```sh
npm i foratata
```

### Basic Usage
```js
import { TaskQueue } from 'foratata';

// Create the queue
const queue = new TaskQueue();

// add tasks: functions that run workloads
queue.push(
  () => delay(1000), // a promise
  () => { throw new Error() }, // something that throws (sync or async)
  () => whatever(), // something sync
);

// Run the queue with concurrency.
 // 2 simultaneous tasks as a time
queue.run(2) // promise here!
  .catch((err) => console.error(err)) // error abstract with all errors
```

All queue lifecycle is emmited as events, and you can subscribe to them to have some feedback on how is going.
We ship an event subscriber that outputs to console.

```js
import { TaskQueue, ConsoleSubscriber } from 'foratata';

// Create the queue
const queue = new TaskQueue();

const unsubscribe = ConsoleSubscriber(queue);
// calling unsubscribe() will stop listening to events
```

## Development setup

To clone the repository use the following commands:

```sh
git clone https://github.com/jmendiara/foratata && cd foratata
```

Use [VSCode development containers](https://code.visualstudio.com/docs/remote/containers),  directly [docker-compose](https://docs.docker.com/compose/)

```sh
# Shell interactive session inside a container
docker-compose run app bash
```

### Available Scripts

- `clean` - remove coverage data, Jest cache and transpiled files,
- `build` - transpile TypeScript to ES6,
- `watch` - interactive watch mode to automatically transpile source files,
- `lint` - lint source files and tests,
- `test` - run tests,
- `test:watch` - interactive watch mode to automatically re-run tests
- `format` - format the code

## License

Copyright 2020 Javier Mendiara Cañardo

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
