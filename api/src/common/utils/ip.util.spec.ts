import 'reflect-metadata';
import { Request } from 'express';
import { getClientIp, isValidIp, normalizeIp } from './ip.util';

function makeReq(opts: {
  ip?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): Request {
  return {
    ip: opts.ip,
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as Request;
}

describe('getClientIp (trust-proxy aware, anti-spoofing)', () => {
  it('uses req.ip (Express trust proxy = dé-spoofé) as the source of truth', () => {
    const req = makeReq({
      ip: '203.0.113.7',
      // Forged headers MUST be ignored now.
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'cf-connecting-ip': '9.9.9.9',
        'true-client-ip': '6.6.6.6',
      },
      remoteAddress: '10.0.0.1',
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('does NOT trust spoofable client headers when req.ip is absent', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '9.9.9.9' },
      remoteAddress: '198.51.100.2',
    });
    // Falls back to the real TCP socket address, not the forged headers.
    expect(getClientIp(req)).toBe('198.51.100.2');
  });

  it('falls back to socket.remoteAddress when req.ip missing', () => {
    const req = makeReq({ remoteAddress: '192.0.2.55' });
    expect(getClientIp(req)).toBe('192.0.2.55');
  });

  it('normalizes IPv4-mapped IPv6 from req.ip', () => {
    const req = makeReq({ ip: '::ffff:203.0.113.7' });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('returns null when no valid IP available', () => {
    const req = makeReq({});
    expect(getClientIp(req)).toBeNull();
  });

  it('ignores an invalid req.ip and uses the socket fallback', () => {
    const req = makeReq({ ip: 'not-an-ip', remoteAddress: '192.0.2.9' });
    expect(getClientIp(req)).toBe('192.0.2.9');
  });
});

describe('isValidIp', () => {
  it('accepts IPv4', () => expect(isValidIp('8.8.8.8')).toBe(true));
  it('accepts IPv6', () => expect(isValidIp('2001:db8::1')).toBe(true));
  it('rejects garbage', () => expect(isValidIp('nope')).toBe(false));
});

describe('normalizeIp', () => {
  it('strips IPv4-mapped IPv6 prefix', () =>
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4'));
  it('leaves plain IPv4 untouched', () =>
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4'));
});
