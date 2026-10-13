type JsonObject = Record<string, unknown>;

const REMOVED_API_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'nullable', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'propertyNames', 'patternProperties',
  'unevaluatedProperties', 'unevaluatedItems', 'contains', 'minContains', 'maxContains', 'allOf', 'not',
  'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
]);

function nullable(schema: JsonObject): JsonObject {
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * Projects a domain JSON Schema into the Structured Outputs subset. Semantic
 * constraints removed here remain enforced by the unchanged domain parser and
 * Validator after the response crosses the API boundary.
 */
export function strictApiProjection(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictApiProjection);
  if (!schema || typeof schema !== 'object') return schema;
  const input = schema as JsonObject;
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (REMOVED_API_KEYWORDS.has(key) || key === 'prefixItems' || key === 'const') continue;
    if (key === 'type' && Array.isArray(value)) continue;
    output[key] = strictApiProjection(value);
  }
  if ('const' in input) output.enum = [input.const];
  if (input.type === 'array' && Array.isArray(input.prefixItems)) output.items = strictApiProjection(input.prefixItems[0]);
  if (Array.isArray(input.type)) {
    const nonNull = input.type.filter((type) => type !== 'null');
    if (nonNull.length !== 1) throw new Error('STRICT_API_PROJECTION_TYPE_UNION_UNSUPPORTED');
    return nullable(strictApiProjection({ ...input, type: nonNull[0] }) as JsonObject);
  }
  if (input.type === 'object' && input.properties && typeof input.properties === 'object') {
    const properties = input.properties as JsonObject;
    const required = new Set(Array.isArray(input.required) ? input.required as string[] : []);
    output.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const projected = strictApiProjection(value) as JsonObject;
      return [key, required.has(key) ? projected : nullable(projected)];
    }));
    output.required = Object.keys(properties);
    output.additionalProperties = false;
  }
  return output;
}

/** Removes transport-only null placeholders before domain parsing. */
export function stripNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullProperties);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonObject)
    .filter(([, item]) => item !== null)
    .map(([key, item]) => [key, stripNullProperties(item)]));
}
