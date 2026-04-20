import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createErrorResponseFrame,
  createWelcomeFrame,
  parseIncomingFrame,
  PROTOCOL_VERSION,
} from '../src/broker/protocol.ts';

test('protocol parses valid hello frames', () => {
  const frame = parseIncomingFrame(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'hello',
      extensionId: 'abc',
      version: '1.2.3',
      capabilities: ['run_task'],
    }),
  );

  assert.equal(frame.kind, 'hello');
  assert.equal(frame.extensionId, 'abc');
});

test('protocol rejects malformed response frames', () => {
  assert.throws(
    () =>
      parseIncomingFrame(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'response',
          id: 'req-1',
          ok: false,
        }),
      ),
    /must include error/,
  );
});

test('protocol creates welcome and error response frames', () => {
  const welcome = createWelcomeFrame('0.0.0');
  const error = createErrorResponseFrame('req-1', 'E_INTERNAL', 'boom');

  assert.equal(welcome.kind, 'welcome');
  assert.equal(typeof welcome.serverTime, 'number');
  assert.deepEqual(error.error, { code: 'E_INTERNAL', message: 'boom', details: undefined });
});
