import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value).every(isJsonValue);
}

/** Keep legacy rendering/history intact while exposing the same data to SDK callers. */
export function withNativeResult<TParams extends TSchema>(tool: ToolDefinition<TParams, Record<string, unknown>>): ToolDefinition<TParams, Record<string, unknown>> {
  return {
    ...tool,
    outputSchema: Type.Object({}, { additionalProperties: true }),
    async execute(...args) {
      const result = await tool.execute(...args);
      // Details already cross a JSON session boundary. Normalize optional undefined
      // fields exactly as persistence does, without mutating the original details.
      const structuredContent: unknown = JSON.parse(JSON.stringify(result.details));
      if (!isJsonValue(structuredContent)) throw new TypeError('Browser result is not JSON data');
      return {
        ...result,
        structuredContent,
        isError: result.isError === true || result.details.ok === false || result.details.success === false,
      };
    },
  };
}
