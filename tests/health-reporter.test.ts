import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHealthReporter, quietBrokerLogger, RECOVERY_GRACE_MS } from '../src/broker/health-reporter.ts';

function harness() {
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  const reporter = new BrowserHealthReporter({
    setStatus(key, value) { assert.equal(key, 'browser-bridge'); statuses.push(value); },
    notify(message, type) { assert.equal(type, 'warning'); notifications.push(message); },
  });
  return { reporter, statuses, notifications };
}

test('initial state and transient disconnects only update the status line', () => {
  const { reporter, statuses, notifications } = harness();
  reporter.observe(true, 0);
  reporter.observe(true, 1);
  reporter.observe(false, 2);
  reporter.observe(false, RECOVERY_GRACE_MS);
  reporter.observe(true, RECOVERY_GRACE_MS + 1);
  assert.deepEqual(statuses, ['browser: connected', 'browser: recovering', 'browser: connected']);
  assert.deepEqual(notifications, []);
});

test('sustained failure warns once, regardless of repeated recovery attempts', () => {
  const { reporter, statuses, notifications } = harness();
  reporter.observe(false, 0);
  reporter.observe(false, RECOVERY_GRACE_MS - 1);
  assert.equal(notifications.length, 0);
  reporter.observe(false, RECOVERY_GRACE_MS);
  for (let i = 1; i <= 100; i++) reporter.observe(false, RECOVERY_GRACE_MS + i * 2_000);
  assert.deepEqual(statuses, ['browser: recovering', 'browser: disconnected']);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].length < 120);
  assert.ok(!notifications[0].includes('\n'));
  reporter.observe(true, 300_000);
  reporter.observe(false, 300_001);
  reporter.observe(false, 300_001 + RECOVERY_GRACE_MS);
  assert.equal(notifications.length, 2, 'a separate outage gets its own warning');
});

test('resume gives recovery time without repeating an existing warning', () => {
  const { reporter, notifications } = harness();
  reporter.observe(false, 0);
  reporter.resume();
  reporter.observe(false, 300_000);
  reporter.observe(true, 300_001);
  assert.deepEqual(notifications, []);
  reporter.observe(false, 300_002);
  reporter.observe(false, 300_002 + RECOVERY_GRACE_MS);
  assert.equal(notifications.length, 1);
  reporter.resume();
  reporter.observe(false, 600_000);
  reporter.observe(false, 600_000 + RECOVERY_GRACE_MS);
  assert.equal(notifications.length, 1);
});

test('shutdown clears status and ignores late recovery completions', () => {
  const { reporter, statuses, notifications } = harness();
  reporter.observe(false, 0);
  reporter.dispose();
  reporter.observe(false, RECOVERY_GRACE_MS);
  reporter.observe(true, RECOVERY_GRACE_MS + 1);
  assert.deepEqual(statuses, ['browser: recovering', undefined]);
  assert.deepEqual(notifications, []);
});

test('low-level logs never reach the runtime console, even with stack traces', (t) => {
  const spies = ['info', 'warn', 'error'].map((method) => t.mock.method(console, method as 'warn', () => {}));
  const error = new Error('failure\n    at internal-frame.ts:123');
  quietBrokerLogger.info?.('connected', error);
  quietBrokerLogger.warn?.('retrying', error);
  quietBrokerLogger.error?.('failed', error);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});
