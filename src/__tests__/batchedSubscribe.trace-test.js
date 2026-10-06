import expect from 'expect';
import { createTracedStore } from '../batchedSubscribe.trace';

function reducer(state, action) {
  const base = state && state.value ? state.value : 0;
  return { value: base + (action.payload || 1) };
}

function fakeClock() {
  let t = 0;
  return {
    tick(ms) { t += ms; },
    now() { return t; }
  };
}

function immediateScheduler() {
  return notify => notify();
}

function coalescingScheduler() {
  let pending = null;
  let scheduled = false;

  function flush() {
    scheduled = false;
    const notify = pending;
    pending = null;
    if (notify) {
      notify();
    }
  }

  function schedule(notify) {
    pending = notify;
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  }

  schedule.flush = flush;
  return schedule;
}

function createStore(scheduler, clock) {
  return createTracedStore({ scheduler, now: clock && clock.now })(reducer, { value: 0 });
}

describe('traceStore', () => {
  it('has the same calling signature as createStore', () => {
    const store = createTracedStore()(reducer, { value: 5 });
    expect(store.getState().value).toBe(5);
    expect(typeof store.dispatch).toBe('function');
    expect(typeof store.subscribe).toBe('function');
    expect(typeof store.getTrace).toBe('function');
  });

  it('records ordinal, call count and duration per round', () => {
    const clock = fakeClock();
    const store = createStore(immediateScheduler(), clock);

    store.subscribe(function a() { clock.tick(2); }, 'a');
    store.subscribe(function b() { clock.tick(3); }, 'b');

    store.dispatch({ type: 'inc' });

    const trace = store.getTrace();
    expect(trace.notifying).toBe(false);
    expect(trace.rounds.length).toBe(1);
    expect(trace.rounds[0].listeners.map(e => e.ordinal)).toEqual([1, 2]);
    expect(trace.rounds[0].listeners.map(e => e.name)).toEqual(['a', 'b']);
    expect(trace.rounds[0].listeners.map(e => e.callCount)).toEqual([1, 1]);
    expect(trace.rounds[0].listeners.map(e => e.duration)).toEqual([2, 3]);
    expect(trace.rounds[0].duration).toBe(5);
  });

  it('counts each immediate dispatch as its own round', () => {
    const store = createStore(immediateScheduler());
    store.subscribe(() => {});

    store.dispatch({ type: 'inc' });
    store.dispatch({ type: 'inc' });

    expect(store.getTrace().rounds.length).toBe(2);
  });

  it('excludes listeners subscribed mid-notification from the current round', () => {
    const store = createStore(immediateScheduler());
    const seen = [];

    store.subscribe(() => {
      seen.push('first');
      store.subscribe(() => seen.push('added'));
    });
    store.subscribe(() => seen.push('second'));

    store.dispatch({ type: 'inc' });

    expect(seen).toEqual(['first', 'second']);
    const round = store.getTrace().rounds[0];
    expect(round.listeners.map(e => e.name)).toEqual(['listener_1', 'listener_2']);

    store.dispatch({ type: 'inc' });
    expect(seen).toEqual(['first', 'second', 'first', 'second', 'added']);
  });

  it('keeps listeners unsubscribed mid-notification inside the current snapshot', () => {
    const store = createStore(immediateScheduler());
    let removeSecond;

    store.subscribe(() => {});
    removeSecond = store.subscribe(() => removeSecond());
    store.subscribe(() => {});

    store.dispatch({ type: 'inc' });

    const firstRound = store.getTrace().rounds[0];
    expect(firstRound.listeners.map(e => e.ordinal)).toEqual([1, 2, 3]);

    store.dispatch({ type: 'inc' });
    const secondRound = store.getTrace().rounds[1];
    expect(secondRound.listeners.map(e => e.ordinal)).toEqual([1, 2]);
  });

  it('tracks nested dispatches as nested rounds and resets the notifying flag', () => {
    const store = createStore(immediateScheduler());
    const states = [];
    let unsubscribeOuter;

    unsubscribeOuter = store.subscribe(function outer() {
      states.push(store.isNotifying());
      unsubscribeOuter();
      store.dispatch({ type: 'nested' });
    }, 'outer');
    store.subscribe(function inner() {}, 'inner');

    expect(store.isNotifying()).toBe(false);
    store.dispatch({ type: 'outer' });
    expect(store.isNotifying()).toBe(false);

    const trace = store.getTrace();
    expect(trace.rounds.length).toBe(2);
    expect(trace.rounds[0].listeners.map(e => e.name)).toEqual(['outer', 'inner']);
    expect(trace.rounds[1].listeners.map(e => e.name)).toEqual(['inner']);
    expect(trace.rounds[1].listeners[0].round).toBe(2);
    expect(states).toEqual([true]);
  });

  it('restores the notifying flag when a listener throws', () => {
    const store = createStore(immediateScheduler());
    store.subscribe(() => { throw new Error('boom'); });

    expect(() => store.dispatch({ type: 'inc' })).toThrow();
    expect(store.isNotifying()).toBe(false);
  });

  it('lets an injected scheduler coalesce multiple dispatches into one round', done => {
    const scheduler = coalescingScheduler();
    const store = createStore(scheduler);
    store.subscribe(() => {});

    store.dispatch({ type: 'one' });
    store.dispatch({ type: 'two' });
    store.dispatch({ type: 'three' });

    expect(store.getTrace().rounds.length).toBe(0);

    setImmediate(() => {
      const trace = store.getTrace();
      expect(trace.rounds.length).toBe(1);
      expect(trace.rounds[0].listeners.length).toBe(1);
      expect(trace.rounds[0].listeners[0].callCount).toBe(1);
      done();
    });
  });

  it('applies the snapshot per flushed round on the async path', done => {
    const scheduler = coalescingScheduler();
    const store = createStore(scheduler);
    const seen = [];

    store.subscribe(() => {
      seen.push('first');
      store.subscribe(() => seen.push('added'));
    });
    store.subscribe(() => seen.push('second'));

    store.dispatch({ type: 'one' });
    store.dispatch({ type: 'two' });

    setImmediate(() => {
      expect(seen).toEqual(['first', 'second']);
      expect(store.getTrace().rounds[0].listeners.length).toBe(2);

      store.dispatch({ type: 'three' });
      setImmediate(() => {
        expect(seen).toEqual(['first', 'second', 'first', 'second', 'added']);
        const rounds = store.getTrace().rounds;
        expect(rounds[1].listeners.map(e => e.name))
          .toEqual(['listener_1', 'listener_2', 'listener_3']);
        done();
      });
    });
  });

  it('throws when the traced subscriber is not a function', () => {
    const store = createStore(immediateScheduler());
    expect(() => store.subscribe(null)).toThrow();
  });
});
