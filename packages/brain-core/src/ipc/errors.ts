/**
 * Base error for IPC operations.
 */
export class IpcError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when IPC params fail validation.
 */
export class ValidationError extends IpcError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when a requested method or resource is not found.
 */
export class NotFoundError extends IpcError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when an IPC operation times out.
 */
export class TimeoutError extends IpcError {
  constructor(message: string = 'Operation timed out') {
    super(message, 'TIMEOUT', 408);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when a required service is not available.
 */
export class ServiceUnavailableError extends IpcError {
  constructor(message: string = 'Service unavailable') {
    super(message, 'SERVICE_UNAVAILABLE', 503);
    this.name = 'ServiceUnavailableError';
  }
}
