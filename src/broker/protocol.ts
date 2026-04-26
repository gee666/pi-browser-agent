import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const PROTOCOL_VERSION = 1;

const ErrorFrameSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

export const HelloFrameSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal('hello'),
  extensionId: Type.String(),
  version: Type.String(),
  capabilities: Type.Array(Type.String()),
});

export const WelcomeFrameSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal('welcome'),
  brokerVersion: Type.String(),
  serverTime: Type.Number(),
});

export const ProbeFrameSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal('probe'),
  id: Type.Optional(Type.String()),
});

export const RequestFrameSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal('request'),
  id: Type.String(),
  type: Type.String(),
  params: Type.Optional(Type.Unknown()),
});

export const ResponseFrameSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION),
  kind: Type.Literal('response'),
  id: Type.String(),
  ok: Type.Boolean(),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(ErrorFrameSchema),
});

export const AnyIncomingFrameSchema = Type.Union([
  HelloFrameSchema,
  ProbeFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
]);

export type HelloFrame = Static<typeof HelloFrameSchema>;
export type WelcomeFrame = Static<typeof WelcomeFrameSchema>;
export type ProbeFrame = Static<typeof ProbeFrameSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type IncomingFrame = Static<typeof AnyIncomingFrameSchema>;

export interface ProbeResult {
  brokerReachable: boolean;
  brokerListening: boolean;
  bridgeConnected: boolean;
  bridgeVersion?: string;
  capabilities?: string[];
  startupError?: string;
  url?: string;
  bridgeSessionSerial?: number;
  supportsBrokerProxy?: boolean;
}

export function parseIncomingFrame(raw: string): IncomingFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON frame: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Value.Check(AnyIncomingFrameSchema, parsed)) {
    throw new Error('Invalid protocol frame');
  }

  if (parsed.kind === 'response') {
    if (parsed.ok && parsed.error) {
      throw new Error('Response frame cannot include error when ok=true');
    }
    if (!parsed.ok && !parsed.error) {
      throw new Error('Response frame must include error when ok=false');
    }
  }

  return parsed;
}

export function createWelcomeFrame(brokerVersion: string): WelcomeFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'welcome',
    brokerVersion,
    serverTime: Date.now(),
  };
}

export function createResponseFrame(id: string, data: unknown): ResponseFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'response',
    id,
    ok: true,
    data,
  };
}

export function createErrorResponseFrame(id: string, code: string, message: string, details?: unknown): ResponseFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'response',
    id,
    ok: false,
    error: { code, message, details },
  };
}
