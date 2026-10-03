import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/config/logger.js';

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('writes info/warn/debug through console.log with the module tag and message', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('test/module');

    logger.info('hello', { foo: 'bar' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'info',
      module: 'test/module',
      message: 'hello',
      foo: 'bar',
    });
    expect(typeof logged.timestamp).toBe('string');
  });

  it('writes error through console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test/module');

    logger.error('boom', { error: 'nope' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'error',
      module: 'test/module',
      message: 'boom',
      error: 'nope',
    });
  });

  it('writes warn and debug through console.log, distinguished by the level field', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('test/module');

    logger.warn('careful');
    logger.debug('details');

    expect(logSpy).toHaveBeenCalledTimes(2);
    const warnEntry = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    const debugEntry = JSON.parse(logSpy.mock.calls[1][0] as string) as Record<string, unknown>;
    expect(warnEntry).toMatchObject({ level: 'warn', message: 'careful' });
    expect(debugEntry).toMatchObject({ level: 'debug', message: 'details' });
  });

  it('scopes independently-created loggers to their own module name', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = createLogger('module/a');
    const b = createLogger('module/b');

    a.info('from a');
    b.info('from b');

    const first = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    const second = JSON.parse(logSpy.mock.calls[1][0] as string) as Record<string, unknown>;
    expect(first.module).toBe('module/a');
    expect(second.module).toBe('module/b');
  });

  it('drops debug entries by default but keeps info and above', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test/module');

    logger.debug('noise');
    logger.info('kept');
    logger.error('kept too');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('honors LOG_LEVEL and falls back to info for an unrecognized value', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('test/module');

    vi.stubEnv('LOG_LEVEL', 'warn');
    logger.info('dropped');
    logger.warn('kept');
    expect(logSpy).toHaveBeenCalledTimes(1);

    vi.stubEnv('LOG_LEVEL', 'verbose');
    logger.info('kept under fallback');
    expect(logSpy).toHaveBeenCalledTimes(2);
  });
});
