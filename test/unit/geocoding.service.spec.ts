import { ConfigService } from '@nestjs/config';
import { GeocodingService } from '../../src/modules/geocoding/geocoding.service';

describe('GeocodingService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function serviceWithKey(apiKey: string) {
    const config = { get: jest.fn().mockReturnValue(apiKey) } as unknown as ConfigService;
    return new GeocodingService(config);
  }

  it('returns an empty suggestion, not a throw, when no API key is configured (FR-013)', async () => {
    const config = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const service = new GeocodingService(config);

    await expect(service.reverseGeocode(24.7136, 46.6753)).resolves.toEqual({ addressText: '' });
  });

  it('returns the formatted address on a successful Google response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [{ formatted_address: 'طريق الملك فهد، الرياض' }],
      }),
    }) as unknown as typeof fetch;

    const service = serviceWithKey('test-key');
    await expect(service.reverseGeocode(24.7136, 46.6753)).resolves.toEqual({
      addressText: 'طريق الملك فهد، الرياض',
    });
  });

  it('returns an empty suggestion, not a throw, on a non-OK HTTP response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    const service = serviceWithKey('test-key');
    await expect(service.reverseGeocode(24.7136, 46.6753)).resolves.toEqual({ addressText: '' });
  });

  it('returns an empty suggestion, not a throw, when Google reports a non-OK status or no results', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    }) as unknown as typeof fetch;

    const service = serviceWithKey('test-key');
    await expect(service.reverseGeocode(0, 0)).resolves.toEqual({ addressText: '' });
  });

  it('returns an empty suggestion, not a throw, on a network error', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const service = serviceWithKey('test-key');
    await expect(service.reverseGeocode(24.7136, 46.6753)).resolves.toEqual({ addressText: '' });
  });

  it('returns an empty suggestion, not a throw, when the request times out', async () => {
    global.fetch = jest.fn().mockImplementation(
      (_url, options?: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Mirrors what AbortController actually does — reject fetch's own
          // promise, not just fire the signal — so the timeout path is
          // exercised realistically rather than assumed to behave this way.
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const service = serviceWithKey('test-key');
    const result = await service.reverseGeocode(24.7136, 46.6753);
    expect(result).toEqual({ addressText: '' });
  }, 10_000);
});
