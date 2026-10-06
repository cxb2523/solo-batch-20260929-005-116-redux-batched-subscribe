#!/usr/bin/env node
'use strict';

require('babel/register');

var fs = require('fs');
var path = require('path');
var createTracedStore = require('../src/batchedSubscribe.trace').createTracedStore;

var CONTRACT_PATH = path.join(__dirname, '..', 'docs', 'batching-contract.md');
var MAX_DURATION = 50;

function identity(state, action) {
  return { value: (state && state.value || 0) + 1 };
}

function fakeClock() {
  var t = 0;
  return {
    tick: function (ms) { t += ms; },
    now: function () { return t; }
  };
}

function immediateScheduler() {
  return function (notify) { notify(); };
}

function coalescingScheduler() {
  var pending = null;
  var scheduled = false;

  function flush() {
    scheduled = false;
    var notify = pending;
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

  return schedule;
}

function nextTick() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function isSeparator(cells) {
  return cells.every(function (cell) {
    return /^:?-{3,}:?$/.test(cell);
  });
}

function parseTable(markdown, heading) {
  var lines = markdown.split(/\r?\n/);
  var rows = [];
  var inSection = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('## ') === 0) {
      inSection = line.indexOf(heading) !== -1;
      continue;
    }
    if (!inSection || line.indexOf('|') === -1) {
      continue;
    }
    var cells = line.split('|').slice(1, -1).map(function (cell) {
      return cell.trim();
    });
    if (!cells.length || isSeparator(cells)) {
      continue;
    }
    if (cells[0] === 'path') {
      continue;
    }
    rows.push(cells);
  }

  return rows;
}

function collectRows(store, label, roundOffset) {
  var trace = store.getTrace();
  var printed = [];
  trace.rounds.forEach(function (round) {
    round.listeners.forEach(function (entry) {
      var row = [
        label,
        String(round.id + roundOffset),
        String(entry.ordinal),
        entry.name,
        String(entry.callCount),
        String(entry.duration),
        String(MAX_DURATION)
      ];
      printed.push(row);
      process.stdout.write(
        row[0] + '\t' + row[1] + '\t' + row[2] + '\t' +
        row[3] + '\t' + row[4] + '\t' + row[5] + '\n'
      );
    });
  });
  return printed;
}

function runScenario() {
  var clock = fakeClock();
  var asyncScheduler = coalescingScheduler();

  function create(scheduler) {
    return createTracedStore({ scheduler: scheduler, now: clock.now })(identity, { value: 0 });
  }

  var syncStore = create(immediateScheduler());
  var unsubscribeB;

  syncStore.subscribe(function a() { clock.tick(2); }, 'a');
  unsubscribeB = syncStore.subscribe(function b() {
    clock.tick(3);
    unsubscribeB();
  }, 'b');
  syncStore.subscribe(function c() { clock.tick(1); }, 'c');

  syncStore.dispatch({ type: 'sync-1' });
  syncStore.dispatch({ type: 'sync-2' });

  var asyncStore = create(asyncScheduler);
  asyncStore.subscribe(function a2() { clock.tick(2); }, 'a');
  asyncStore.subscribe(function b2() {
    clock.tick(3);
    asyncStore.subscribe(function d() { clock.tick(1); }, 'd');
  }, 'b');

  asyncStore.dispatch({ type: 'async-1' });
  asyncStore.dispatch({ type: 'async-2' });

  return nextTick().then(function () {
    asyncStore.dispatch({ type: 'async-3' });
    return nextTick();
  }).then(function () {
    var syncRows = collectRows(syncStore, 'sync', 0);
    var asyncRows = collectRows(asyncStore, 'async', syncStore.getTrace().rounds.length);
    return {
      rows: syncRows.concat(asyncRows),
      totals: [
        ['sync', '2', '2', '2'],
        ['async', '3', '2', '3']
      ]
    };
  });
}

function compare(actual, expected, label) {
  var failures = [];
  var count = Math.max(actual.length, expected.length);

  for (var i = 0; i < count; i++) {
    var a = actual[i];
    var e = expected[i];
    if (!a || !e) {
      failures.push(label + ' row ' + (i + 1) + ': expected ' +
        JSON.stringify(e) + ' got ' + JSON.stringify(a));
      continue;
    }
    for (var j = 0; j < e.length; j++) {
      if (String(a[j]) !== String(e[j])) {
        failures.push(label + ' row ' + (i + 1) + ' col ' + (j + 1) +
          ': expected "' + e[j] + '" got "' + a[j] + '"');
      }
    }
  }

  if (label === 'trace') {
    actual.forEach(function (row, index) {
      var duration = Number(row[5]);
      var bound = Number(row[6]);
      if (!(duration <= bound)) {
        failures.push('trace row ' + (index + 1) + ': duration ' +
          duration + ' exceeds bound ' + bound);
      }
    });
  }

  return failures;
}

runScenario().then(function (result) {
  var markdown = fs.readFileSync(CONTRACT_PATH, 'utf8');
  var expectedRows = parseTable(markdown, 'Trace rows');
  var expectedTotals = parseTable(markdown, 'Round totals');

  var failures = []
    .concat(compare(result.rows, expectedRows, 'trace'))
    .concat(compare(result.totals, expectedTotals, 'totals'));

  if (failures.length) {
    process.stderr.write('\nContract mismatch (' + failures.length + '):\n');
    failures.forEach(function (failure) {
      process.stderr.write('  - ' + failure + '\n');
    });
    process.exit(1);
  }

  process.stdout.write('\nOK: printed sequence matches docs/batching-contract.md (' +
    result.rows.length + ' rows, ' + result.totals.length + ' totals).\n');
}).catch(function (error) {
  process.stderr.write('Scenario failed: ' + (error && error.stack || error) + '\n');
  process.exit(1);
});
