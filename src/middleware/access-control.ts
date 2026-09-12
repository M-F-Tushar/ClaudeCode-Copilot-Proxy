import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { RequestHandler } from 'express';

export interface AccessControlOptions {
  host: string;
  port: number;
  authToken?: string;
  allowedOrigins: string[];
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const PUBLIC_PATHS = new Set(['/', '/health', '/auth.html', '/usage.html']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const ALLOWED_HEADERS = new Set([
  'authorization', 'x-api-key', 'content-type', 'anthropic-version', 'anthropic-beta',
  'anthropic-dangerous-direct-browser-access', 'x-requested-with',
]);
const EXPOSED_HEADERS = [
  'X-Proxy-Warnings',
  'X-Proxy-Resolved-Model',
  'X-Proxy-Actual-Model',
  'X-Proxy-Token-Count',
  'X-Proxy-Transport',
  'request-id',
  'Retry-After',
];

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function originUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || value.includes('*')
      || ![url.origin, `${url.origin}/`].includes(value)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function hostAuthority(host: string, port: number): string {
  const bracketed = isIP(host) === 6 ? `[${host}]` : host;
  return new URL(`http://${bracketed}:${port}`).host;
}

export function assertSafeServerConfig(options: AccessControlOptions): void {
  if (!isLoopback(options.host) && !options.authToken?.trim()) {
    throw new Error('PROXY_AUTH_TOKEN is required when HOST is not a loopback address');
  }
  if (options.allowedOrigins.some(origin => !originUrl(origin))) {
    throw new Error('PROXY_ALLOWED_ORIGINS must contain explicit HTTP(S) origins without wildcards');
  }
}

export function accessControl(options: AccessControlOptions): RequestHandler {
  assertSafeServerConfig(options);
  const allowedOrigins = new Set(options.allowedOrigins.map(origin => originUrl(origin)!.origin));
  const originHosts = new Set([...allowedOrigins].map(origin => new URL(origin).host));
  const expectedToken = options.authToken
    ? createHash('sha256').update(options.authToken).digest()
    : undefined;
  const wildcard = ['0.0.0.0', '::', '[::]'].includes(options.host);

  return (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    const reject = (status: number, message: string): void => {
      res.status(status).json({
        type: 'error',
        error: { type: status === 401 ? 'authentication_error' : 'permission_error', message },
      });
    };

    // Build trusted authorities independently of Host / forwarded headers.
    const port = req.socket.localPort ?? options.port;
    const trustedHosts = new Set(LOOPBACK_HOSTS.map(host => hostAuthority(host, port)));
    if (!wildcard) trustedHosts.add(hostAuthority(options.host, port));
    const localAddress = req.socket.localAddress?.replace(/^::ffff:/, '');
    if (wildcard && localAddress) trustedHosts.add(hostAuthority(localAddress, port));
    const host = req.headers.host?.toLowerCase();
    if (!host || /[\s,/@\\?#%]/.test(host)
      || !(trustedHosts.has(host) || (expectedToken && originHosts.has(host)))) {
      reject(403, 'Untrusted Host header');
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      const parsedOrigin = originUrl(origin);
      const sameOrigin = parsedOrigin?.origin === `http://${host}` && trustedHosts.has(host);
      if (!parsedOrigin || (!sameOrigin && !(expectedToken && allowedOrigins.has(parsedOrigin.origin)))) {
        reject(403, 'Untrusted request origin');
        return;
      }
      res.set('Access-Control-Allow-Origin', parsedOrigin.origin);
      res.set('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
      res.vary('Origin');
    } else if (['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site') ?? '')) {
      reject(403, 'Cross-site requests are not allowed');
      return;
    }

    if (req.method === 'OPTIONS' && origin !== undefined) {
      const method = req.get('Access-Control-Request-Method');
      const headers = (req.get('Access-Control-Request-Headers') ?? '')
        .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
      if (!method || !ALLOWED_METHODS.has(method) || headers.some(header => !ALLOWED_HEADERS.has(header))) {
        reject(403, 'Unsupported preflight request');
        return;
      }
      res.set('Access-Control-Allow-Methods', [...ALLOWED_METHODS].join(', '));
      res.set('Access-Control-Allow-Headers', [...ALLOWED_HEADERS].join(', '));
      res.status(204).end();
      return;
    }

    if (expectedToken && !(['GET', 'HEAD'].includes(req.method) && PUBLIC_PATHS.has(req.path))) {
      const authorization = req.get('Authorization');
      const [scheme, credential, ...extra] = authorization?.split(/\s+/) ?? [];
      const bearer = scheme?.toLowerCase() === 'bearer' && extra.length === 0 ? credential ?? '' : '';
      const apiKey = req.get('x-api-key') ?? '';
      // Hash first so comparisons always have the same length, including missing credentials.
      const validApiKey = timingSafeEqual(createHash('sha256').update(apiKey).digest(), expectedToken);
      const validBearer = timingSafeEqual(createHash('sha256').update(bearer).digest(), expectedToken);
      if (!validApiKey && !validBearer) {
        reject(401, 'Proxy authentication required');
        return;
      }
    }
    next();
  };
}
