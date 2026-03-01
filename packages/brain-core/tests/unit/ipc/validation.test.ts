import { describe, it, expect } from 'vitest';
import { validateParams, withValidation } from '../../../src/ipc/validation.js';
import { ValidationError } from '../../../src/ipc/errors.js';

describe('validateParams', () => {
  it('returns empty object for null', () => {
    expect(validateParams(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(validateParams(undefined)).toEqual({});
  });

  it('passes through valid plain object', () => {
    const params = { name: 'test', count: 5, active: true };
    expect(validateParams(params)).toEqual(params);
  });

  it('rejects arrays', () => {
    expect(() => validateParams([1, 2, 3])).toThrow(ValidationError);
    expect(() => validateParams([1, 2, 3])).toThrow('must be a plain object');
  });

  it('rejects strings', () => {
    expect(() => validateParams('hello')).toThrow(ValidationError);
  });

  it('rejects numbers', () => {
    expect(() => validateParams(42)).toThrow(ValidationError);
  });

  it('rejects booleans', () => {
    expect(() => validateParams(true)).toThrow(ValidationError);
  });

  // String length validation
  it('allows strings within length limit', () => {
    const result = validateParams({ text: 'short' });
    expect(result.text).toBe('short');
  });

  it('rejects strings exceeding max length', () => {
    const longString = 'x'.repeat(11_000);
    expect(() => validateParams({ text: longString })).toThrow(ValidationError);
    expect(() => validateParams({ text: longString })).toThrow('exceeds maximum length');
  });

  it('respects custom maxStringLength', () => {
    const text = 'x'.repeat(50);
    expect(() => validateParams({ text }, { maxStringLength: 30 })).toThrow(ValidationError);
    expect(validateParams({ text }, { maxStringLength: 100 })).toEqual({ text });
  });

  // Array length validation
  it('allows arrays within length limit', () => {
    const result = validateParams({ items: [1, 2, 3] });
    expect((result.items as number[]).length).toBe(3);
  });

  it('rejects arrays exceeding max length', () => {
    const bigArray = Array.from({ length: 1001 }, (_, i) => i);
    expect(() => validateParams({ items: bigArray })).toThrow(ValidationError);
    expect(() => validateParams({ items: bigArray })).toThrow('exceeds maximum length');
  });

  it('respects custom maxArrayLength', () => {
    const items = [1, 2, 3, 4, 5];
    expect(() => validateParams({ items }, { maxArrayLength: 3 })).toThrow(ValidationError);
    expect(validateParams({ items }, { maxArrayLength: 10 })).toEqual({ items });
  });

  // Nesting depth validation
  it('allows moderate nesting', () => {
    const params = { a: { b: { c: { d: 'deep' } } } };
    expect(validateParams(params)).toEqual(params);
  });

  it('rejects excessive nesting', () => {
    // Build deeply nested object
    let obj: any = { value: 'leaf' };
    for (let i = 0; i < 12; i++) {
      obj = { nested: obj };
    }
    expect(() => validateParams(obj)).toThrow(ValidationError);
    expect(() => validateParams(obj)).toThrow('nesting depth');
  });

  it('respects custom maxDepth', () => {
    const params = { a: { b: { c: 'deep' } } };
    expect(() => validateParams(params, { maxDepth: 2 })).toThrow(ValidationError);
    expect(validateParams(params, { maxDepth: 5 })).toEqual(params);
  });

  // Nested validation
  it('validates strings inside nested objects', () => {
    const longString = 'x'.repeat(11_000);
    expect(() => validateParams({ nested: { text: longString } })).toThrow(ValidationError);
  });

  it('validates strings inside arrays', () => {
    const longString = 'x'.repeat(11_000);
    expect(() => validateParams({ items: [longString] })).toThrow(ValidationError);
  });

  it('allows primitives in nested structures', () => {
    const params = { a: 1, b: true, c: null, d: { e: 2.5 } };
    expect(validateParams(params)).toEqual(params);
  });
});

describe('withValidation', () => {
  it('wraps a handler with param validation', () => {
    const handler = (params: Record<string, unknown>) => ({ result: params.name });
    const wrapped = withValidation(handler);

    expect(wrapped({ name: 'test' })).toEqual({ result: 'test' });
  });

  it('passes null params as empty object', () => {
    const handler = (params: Record<string, unknown>) => Object.keys(params).length;
    const wrapped = withValidation(handler);

    expect(wrapped(null)).toBe(0);
  });

  it('throws ValidationError for invalid params', () => {
    const handler = (params: Record<string, unknown>) => params;
    const wrapped = withValidation(handler);

    expect(() => wrapped('invalid')).toThrow(ValidationError);
  });

  it('forwards custom validation options', () => {
    const handler = (params: Record<string, unknown>) => params;
    const wrapped = withValidation(handler, { maxStringLength: 5 });

    expect(() => wrapped({ text: 'toolong' })).toThrow(ValidationError);
    expect(wrapped({ text: 'ok' })).toEqual({ text: 'ok' });
  });
});
