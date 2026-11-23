import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
// A primeira importação do app (SDKs de IA, transformação do código) leva dezenas de segundos com a máquina carregada.
// Na fase de import ela não tem prazo; depois, cada `appWith` só reavalia `src` e usa o código já transformado.
import '../src/app';
import type { buildApp } from '../src/app';
import { ipKey } from '../src/rate-limit';
import { client, makeRoute } from './helpers';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** `config.ts` lê o ambiente ao ser importado: cada app nasce com as variáveis do teste. */
async function appWith(vars: Record<string, string>): Promise<App> {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  app = await buildApp({ logger: false });
  return app;
}

const LIMIT = { AUTH_DEVICE_RATE_LIMIT: '3', AUTH_DEVICE_RATE_WINDOW_MIN: '10' };

/** Registro de um aparelho novo, vindo de `remoteAddress` (o padrão do inject é 127.0.0.1). */
function post(a: App, remoteAddress?: string, headers: Record<string, string> = {}) {
  return a.inject({ method: 'POST', url: '/auth/device', remoteAddress, headers, payload: { token: randomBytes(32).toString('base64url') } });
}

async function exhaust(a: App, remoteAddress?: string, headers?: Record<string, string>) {
  for (let i = 0; i < 3; i++) expect((await post(a, remoteAddress, headers)).statusCode).toBe(200);
}

describe('limite de registro em POST /auth/device', () => {
  it('responde 429 acima do limite e libera depois da janela', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = await appWith(LIMIT);
    const api = client(() => a, makeRoute());
    for (let i = 0; i < 3; i++) expect((await api.register()).userId).toBeTruthy();

    const blocked = await post(a, undefined, { origin: 'http://localhost:8081' });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(600);
    // Sem expor, o navegador esconde o cabeçalho do app web em outra origem.
    expect(String(blocked.headers['access-control-expose-headers']).toLowerCase()).toContain('retry-after');

    vi.advanceTimersByTime(10 * 60_000);
    expect((await post(a)).statusCode).toBe(200);
  });

  it('conta cada IP separadamente', async () => {
    const a = await appWith(LIMIT);
    await exhaust(a, '203.0.113.1');
    expect((await post(a, '203.0.113.1')).statusCode).toBe(429);
    expect((await post(a, '203.0.113.2')).statusCode).toBe(200);
  });

  it('agrupa IPv6 pelo /64', async () => {
    const a = await appWith(LIMIT);
    await exhaust(a, '2001:db8:1:2::1');
    expect((await post(a, '2001:db8:1:2:ffff::9')).statusCode).toBe(429);
    expect((await post(a, '2001:db8:1:3::1')).statusCode).toBe(200);
  });

  it('por padrão ignora X-Forwarded-For forjado', async () => {
    const a = await appWith(LIMIT);
    await exhaust(a, '203.0.113.1');
    expect((await post(a, '203.0.113.1', { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(429);
  });

  it('com TRUST_PROXY=uniquelocal usa o IP que o gateway repassa', async () => {
    const a = await appWith({ ...LIMIT, TRUST_PROXY: 'uniquelocal' });
    const gateway = '172.18.0.5';
    await exhaust(a, gateway, { 'x-forwarded-for': '198.51.100.7' });
    expect((await post(a, gateway, { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(429);
    expect((await post(a, gateway, { 'x-forwarded-for': '198.51.100.8' })).statusCode).toBe(200);
    // Vale o último endereço não confiável: o que o cliente pôs antes dele não troca o balde.
    expect((await post(a, gateway, { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })).statusCode).toBe(429);
  });

  it('com TRUST_PROXY em lista só confia nos proxies listados', async () => {
    const a = await appWith({ ...LIMIT, TRUST_PROXY: '172.18.0.0/16' });
    await exhaust(a, '203.0.113.1');
    expect((await post(a, '203.0.113.1', { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(429);
    expect((await post(a, '172.18.0.5', { 'x-forwarded-for': '198.51.100.7' })).statusCode).toBe(200);
  });

  it('AUTH_DEVICE_RATE_LIMIT=0 desliga o limite', async () => {
    const a = await appWith({ AUTH_DEVICE_RATE_LIMIT: '0' });
    for (let i = 0; i < 40; i++) expect((await post(a)).statusCode).toBe(200);
  });

  it('recusa configuração inválida', async () => {
    await expect(appWith({ AUTH_DEVICE_RATE_LIMIT: '-1' })).rejects.toThrow(/AUTH_DEVICE_RATE_LIMIT/);
    await expect(appWith({ AUTH_DEVICE_RATE_WINDOW_MIN: '0' })).rejects.toThrow(/AUTH_DEVICE_RATE_WINDOW_MIN/);
    // `true` confiaria em qualquer X-Forwarded-For, inclusive o forjado pelo cliente.
    await expect(appWith({ TRUST_PROXY: 'true' })).rejects.toThrow(/TRUST_PROXY/);
    await expect(appWith({ TRUST_PROXY: '1' })).rejects.toThrow(/TRUST_PROXY/);
    await expect(appWith({ TRUST_PROXY: '10.0.0.0/99' })).rejects.toThrow(/TRUST_PROXY/);
  });
});

describe('ipKey', () => {
  it('reduz IPv4 mapeado ao IPv4 em qualquer grafia', () => {
    for (const ip of ['::ffff:203.0.113.1', '::ffff:cb00:7101', '0:0:0:0:0:ffff:cb00:7101', '0000:0000:0000:0000:0000:ffff:203.0.113.1'])
      expect(ipKey(ip), ip).toBe('203.0.113.1');
    expect(ipKey('::ffff:cb00:7102')).toBe('203.0.113.2');
  });

  it('agrupa IPv6 nativo pelo /64 e mantém IPv4', () => {
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002:ffff:0:0:9%eth0')).toBe('2001:db8:1:2::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('203.0.113.1')).toBe('203.0.113.1');
  });
});
