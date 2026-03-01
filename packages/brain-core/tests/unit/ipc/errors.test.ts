import { describe, it, expect } from 'vitest';
import {
  IpcError,
  ValidationError,
  NotFoundError,
  TimeoutError,
  ServiceUnavailableError,
} from '../../../src/ipc/errors.js';

describe('IpcError', () => {
  it('has correct properties', () => {
    const err = new IpcError('test message', 'TEST_CODE', 500);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IpcError);
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('IpcError');
  });

  it('defaults to statusCode 400', () => {
    const err = new IpcError('test', 'TEST');
    expect(err.statusCode).toBe(400);
  });
});

describe('ValidationError', () => {
  it('has correct properties', () => {
    const err = new ValidationError('bad input');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('bad input');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe('ValidationError');
  });
});

describe('NotFoundError', () => {
  it('has correct properties', () => {
    const err = new NotFoundError('method not found');

    expect(err).toBeInstanceOf(IpcError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe('method not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe('NotFoundError');
  });
});

describe('TimeoutError', () => {
  it('has correct properties with default message', () => {
    const err = new TimeoutError();

    expect(err).toBeInstanceOf(IpcError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toBe('Operation timed out');
    expect(err.code).toBe('TIMEOUT');
    expect(err.statusCode).toBe(408);
    expect(err.name).toBe('TimeoutError');
  });

  it('accepts custom message', () => {
    const err = new TimeoutError('IPC call timed out after 5s');
    expect(err.message).toBe('IPC call timed out after 5s');
  });
});

describe('ServiceUnavailableError', () => {
  it('has correct properties with default message', () => {
    const err = new ServiceUnavailableError();

    expect(err).toBeInstanceOf(IpcError);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.message).toBe('Service unavailable');
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
    expect(err.name).toBe('ServiceUnavailableError');
  });

  it('accepts custom message', () => {
    const err = new ServiceUnavailableError('Database down');
    expect(err.message).toBe('Database down');
  });
});
