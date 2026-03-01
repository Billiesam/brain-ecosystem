import { ValidationError } from './errors.js';

const MAX_STRING_LENGTH = 10_240; // 10KB per string field
const MAX_ARRAY_LENGTH = 1000;
const MAX_DEPTH = 10;

export interface ValidationOptions {
  maxStringLength?: number;
  maxArrayLength?: number;
  maxDepth?: number;
}

/**
 * Validate IPC method params. Ensures params is a plain object,
 * string fields don't exceed length limits, arrays aren't too large,
 * and nesting isn't too deep. Throws ValidationError on failure.
 */
export function validateParams(params: unknown, options?: ValidationOptions): Record<string, unknown> {
  const maxStr = options?.maxStringLength ?? MAX_STRING_LENGTH;
  const maxArr = options?.maxArrayLength ?? MAX_ARRAY_LENGTH;
  const maxDep = options?.maxDepth ?? MAX_DEPTH;

  // Null/undefined → empty object (many methods accept no params)
  if (params == null) return {};

  // Must be a plain object
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ValidationError('Params must be a plain object');
  }

  // Deep validate
  validateValue(params, 'params', maxStr, maxArr, maxDep, 0);

  return params as Record<string, unknown>;
}

function validateValue(
  value: unknown,
  path: string,
  maxStr: number,
  maxArr: number,
  maxDep: number,
  depth: number,
): void {
  if (depth > maxDep) {
    throw new ValidationError(`Maximum nesting depth exceeded at ${path}`);
  }

  if (typeof value === 'string') {
    if (value.length > maxStr) {
      throw new ValidationError(`String field "${path}" exceeds maximum length of ${maxStr}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > maxArr) {
      throw new ValidationError(`Array field "${path}" exceeds maximum length of ${maxArr}`);
    }
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], `${path}[${i}]`, maxStr, maxArr, maxDep, depth + 1);
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    for (const [key, val] of entries) {
      validateValue(val, `${path}.${key}`, maxStr, maxArr, maxDep, depth + 1);
    }
    return;
  }

  // Primitives (number, boolean, null) are fine
}

/**
 * Create a validated IPC handler wrapper. Validates params before passing to the handler.
 */
export function withValidation<T>(
  handler: (params: Record<string, unknown>) => T,
  options?: ValidationOptions,
): (params: unknown) => T {
  return (params: unknown) => {
    const validated = validateParams(params, options);
    return handler(validated);
  };
}
