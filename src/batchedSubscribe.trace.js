import { batchedSubscribe } from './';

const defaultScheduler = notify => notify();

function createMiniStore(reducer, preloadedState) {
  let currentState = preloadedState;

  function getState() {
    return currentState;
  }

  function dispatch(action) {
    currentState = reducer(currentState, action);
    return action;
  }

  function subscribe() {
    return function noopUnsubscribe() {};
  }

  return { dispatch, subscribe, getState };
}

export function createTracedStore(options = {}) {
  const scheduler = options.scheduler || defaultScheduler;
  const now = options.now || (() => Date.now());
  const createStore = options.createStore || createMiniStore;

  const rounds = [];
  const callCounts = Object.create(null);
  const roundStack = [];
  let registrationSeq = 0;

  function beginRound() {
    const round = {
      id: rounds.length + 1,
      startedAt: now(),
      endedAt: null,
      duration: null,
      listeners: []
    };
    rounds.push(round);
    roundStack.push(round);
    return round;
  }

  function endRound(round) {
    round.endedAt = now();
    round.duration = round.endedAt - round.startedAt;
    roundStack.pop();
  }

  function batch(notify) {
    return scheduler(function tracedNotify() {
      const round = beginRound();
      try {
        return notify();
      } finally {
        endRound(round);
      }
    });
  }

  const tracedEnhancer = batchedSubscribe(batch);

  function traceListener(listener, id, name) {
    return function tracedListener() {
      const round = roundStack[roundStack.length - 1];
      const ordinal = round.listeners.length + 1;
      const callCount = (callCounts[id] || 0) + 1;
      callCounts[id] = callCount;
      const startedAt = now();
      try {
        return listener();
      } finally {
        round.listeners.push({
          round: round.id,
          ordinal,
          id,
          name,
          callCount,
          duration: now() - startedAt
        });
      }
    };
  }

  return function traceStore(reducer, preloadedState) {
    const store = tracedEnhancer(createStore)(reducer, preloadedState);

    function subscribe(listener, name) {
      if (typeof listener !== 'function') {
        throw new Error('Expected listener to be a function.');
      }
      registrationSeq += 1;
      const id = registrationSeq;
      const traced = traceListener(listener, id, name || `listener_${id}`);
      return store.subscribe(traced);
    }

    function dispatch(action) {
      return store.dispatch(action);
    }

    function getTrace() {
      return {
        notifying: roundStack.length > 0,
        rounds: rounds.map(round => ({
          id: round.id,
          startedAt: round.startedAt,
          endedAt: round.endedAt,
          duration: round.duration,
          listeners: round.listeners.map(entry => ({
            round: entry.round,
            ordinal: entry.ordinal,
            id: entry.id,
            name: entry.name,
            callCount: entry.callCount,
            duration: entry.duration
          }))
        }))
      };
    }

    function resetTrace() {
      rounds.length = 0;
      roundStack.length = 0;
      Object.keys(callCounts).forEach(key => {
        delete callCounts[key];
      });
    }

    return {
      ...store,
      dispatch,
      subscribe,
      getTrace,
      resetTrace,
      subscribeImmediate: store.subscribeImmediate,
      isNotifying: () => roundStack.length > 0
    };
  };
}

export const traceStore = createTracedStore();
