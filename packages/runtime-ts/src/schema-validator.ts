export type SchemaValidation = { valid: true } | { valid: false; error: string };

export function validateSchema(value: unknown, schema: Record<string, unknown>, location = "params"): SchemaValidation {
  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) { const result = validateSchema(value, objectSchema(item), location); if (!result.valid) return result; }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((item) => validateSchema(value, objectSchema(item), location));
    if (!results.some((result) => result.valid)) return invalid(`${location} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => validateSchema(value, objectSchema(item), location).valid).length;
    if (matches !== 1) return invalid(`${location} must match exactly one allowed schema`);
  }
  if (schema.const !== undefined && !same(value, schema.const)) return invalid(`${location} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => same(value, item))) return invalid(`${location} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);

  const types = Array.isArray(schema.type) ? schema.type.map(String) : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) return invalid(`${location} must be ${types.join(" or ")}`);

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < Number(schema.minLength)) return invalid(`${location} must contain at least ${schema.minLength} character(s)`);
    if (Number.isInteger(schema.maxLength) && value.length > Number(schema.maxLength)) return invalid(`${location} must contain at most ${schema.maxLength} character(s)`);
    if (typeof schema.pattern === "string") { try { if (!new RegExp(schema.pattern).test(value)) return invalid(`${location} does not match the required pattern`); } catch { return invalid(`${location} has an invalid schema pattern`); } }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return invalid(`${location} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) return invalid(`${location} must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return invalid(`${location} must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return invalid(`${location} must be < ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < Number(schema.minItems)) return invalid(`${location} must contain at least ${schema.minItems} item(s)`);
    if (Number.isInteger(schema.maxItems) && value.length > Number(schema.maxItems)) return invalid(`${location} must contain at most ${schema.maxItems} item(s)`);
    if (schema.items && typeof schema.items === "object") {
      for (let index = 0; index < value.length; index += 1) { const result = validateSchema(value[index], objectSchema(schema.items), `${location}[${index}]`); if (!result.valid) return result; }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) if (!(key in record)) return invalid(`${location}.${key} is required`);
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
    for (const [key, item] of Object.entries(record)) {
      if (key in properties) { const result = validateSchema(item, objectSchema(properties[key]), `${location}.${key}`); if (!result.valid) return result; }
      else if (schema.additionalProperties === false) return invalid(`${location}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") { const result = validateSchema(item, objectSchema(schema.additionalProperties), `${location}.${key}`); if (!result.valid) return result; }
    }
  }
  return { valid: true };
}

const invalid = (error: string): SchemaValidation => ({ valid: false, error });
const objectSchema = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function matchesType(value: unknown, type: string): boolean {
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}
