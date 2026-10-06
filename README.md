redux-batched-subscribe
=====================

[![build status](https://img.shields.io/travis/tappleby/redux-batched-subscribe/master.svg?style=flat-square)](https://travis-ci.org/tappleby/redux-batched-subscribe)
[![npm version](https://img.shields.io/npm/v/redux-batched-subscribe.svg?style=flat-square)](https://www.npmjs.com/package/redux-batched-subscribe)

Store enhancer for [redux](https://github.com/rackt/redux) which allows batching of subscribe notifications that occur as a result of dispatches.

```js
npm install --save redux-batched-subscribe
```

## Usage

The `batchedSubscribe` store enhancer accepts a function which is called after every dispatch with a `notify` callback as a single argument. Calling the `notify` callback will trigger all the subscription handlers, this gives you the ability to use various techniques to delay subscription notifications such as: debouncing, React batched updates or requestAnimationFrame.

Since `batchedSubscribe` overloads the dispatch and subscribe handlers on the original redux store it is important that it gets applied before any other store enhancers or middleware that depend on these functions; The [compose](https://github.com/rackt/redux/blob/master/docs/api/compose.md) utility in redux can be used to handle this:

```js
import { createStore, applyMiddleware, compose } from 'redux';
import { batchedSubscribe } from 'redux-batched-subscribe';

const enhancer = compose(
  applyMiddleware(...middleware),
  batchedSubscribe((notify) => {
    notify();
  })
)

// Note: passing enhancer as the last argument to createStore requires redux@>=3.1.0
const store = createStore(reducer, initialState, enhancer);
```

*Note: since `compose` applies functions from right to left, `batchedSubscribe` should appear at the end of the chain.*

The store enhancer also exposes a `subscribeImmediate` method which allows for unbatched subscribe notifications.

## Examples

### Debounced subscribe handlers:

```js
import { createStore } from 'redux';
import { batchedSubscribe } from 'redux-batched-subscribe';
import debounce from 'lodash.debounce';

const debounceNotify = debounce(notify => notify());
// Note: passing batchedSubscribe as the last argument to createStore requires redux@>=3.1.0
const store = createStore(reducer, intialState, batchedSubscribe(debounceNotify));
```

### React batched updates

```js
import { createStore } from 'redux';
import { batchedSubscribe } from 'redux-batched-subscribe';

// React >= 0.14
import { unstable_batchedUpdates } from 'react-dom';

// Note: passing batchedSubscribe as the last argument to createStore requires redux@>=3.1.0
const store = createStore(reducer, intialState, batchedSubscribe(unstable_batchedUpdates));
```

## Thanks

Thanks to [Andrew Clark](https://github.com/acdlite) for the clean library structure.

## Tracing wrapper

`src/batchedSubscribe.trace.js` exposes a reusable tracing layer built on top of
the unmodified `batchedSubscribe` enhancer:

```js
import { traceStore, createTracedStore } from './src/batchedSubscribe.trace';

// traceStore is a ready-to-use createStore(reducer, preloadedState) function.
const store = traceStore(rootReducer, initialState);

store.subscribe(() => render(), 'render');
store.dispatch({ type: 'tick' });

store.getTrace();
// { notifying: false, rounds: [{ id, duration, listeners: [
//   { round, ordinal, id, name, callCount, duration } ] }] }
```

Inject a scheduler to decide where batching lands. An immediate scheduler counts
each dispatch as one round; a coalescing/async scheduler merges every dispatch
issued in the same tick into a single round:

```js
const store = createTracedStore({
  scheduler: notify => setImmediate(notify), // injected (fake) scheduler
  now: () => clock.now()                      // injectable clock for tests
})(rootReducer, initialState);
```

The three moving parts are tied together at a single point: the
`currentListeners`/`nextListeners` snapshot is swapped inside the original
`notify()`, the re-entrant `notifying` round stack is set/reset around it, and
the injected scheduler decides when the wrapped notification (and therefore a
new round) actually runs. Listeners added or removed mid-notification follow the
snapshot semantics — removals still run once in the current round, additions are
absent until the next one.

Open `examples/trace-viewer.html` in a browser for an interactive timeline of
sync rounds and coalesced async rounds.

The machine-checked behaviour lives in `docs/batching-contract.md`; verify it
with:

```
npm run trace:check   # node scripts/trace-batching.js
```

The script prints the per-listener call sequence and exits non-zero if it does
not match the contract tables line by line.
