import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaqnyatSmsSender } from '../../src/common/sms/taqnyat-sms-sender';

/**
 * spec 015 US1 T035 — `TaqnyatSmsSender` already satisfies FR-002/004/005/006/
 * 007/008 (research R6); this suite pins the behaviours the feature relies on:
 * the surprising `201`-with-a-rejected-recipient, timeout / non-2xx throws, a
 * log line that never carries the body or a code, and the deliberately narrow
 * `05…` expansion.
 */
describe('TaqnyatSmsSender (spec 015 US1)', () => {
  const config = {
    get: (key: string) =>
      (
        ({
          'sms.endpointUrl': 'https://api.taqnyat.sa/v1/messages',
          'sms.apiKey': 'real-token',
          'sms.senderId': 'ciro',
        }) as Record<string, string>
      )[key],
  } as unknown as ConfigService;

  let sender: TaqnyatSmsSender;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    sender = new TaqnyatSmsSender(config);
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => jest.restoreAllMocks());

  const okResponse = (payload: unknown, status = 201) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });

  it('throws when a 201 lists the recipient under `rejected`', async () => {
    fetchMock.mockResolvedValue(okResponse({ rejected: '[966500000000]', messageId: 'm1' }));
    await expect(sender.send('+966500000000', 'code 123456')).rejects.toThrow(/rejected the recipient/);
  });

  it('accepts a 201 whose `rejected` is an empty array', async () => {
    fetchMock.mockResolvedValue(okResponse({ rejected: '[]', messageId: 'm2' }));
    await expect(sender.send('+966500000000', 'code 123456')).resolves.toBeUndefined();
  });

  it('throws on a network failure / timeout', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(sender.send('+966500000000', 'code 123456')).rejects.toThrow(/Taqnyat request failed/);
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'bad token' }) });
    await expect(sender.send('+966500000000', 'code 123456')).rejects.toThrow(/HTTP 401/);
  });

  it('never logs the message body or the code', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(okResponse({ rejected: '[]', messageId: 'abc-123' }));

    await sender.send('+966500000000', 'Your CIRO Fuel sign-in code is 987654');

    expect(logSpy).toHaveBeenCalled();
    for (const call of logSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toMatch(/987654/);
      expect(line).not.toMatch(/sign-in code/);
    }
  });

  it('expands a Saudi local 05XXXXXXXX to 966XXXXXXXXX, and leaves a non-Saudi leading zero alone', async () => {
    fetchMock.mockResolvedValue(okResponse({ rejected: '[]', messageId: 'm' }));

    await sender.send('0512345678', 'x');
    let body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.recipients).toEqual([966512345678]);

    fetchMock.mockClear();
    await sender.send('0102345678', 'x'); // Egyptian-style leading zero — NOT a Saudi 05
    body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.recipients).toEqual([102345678]);
  });
});
