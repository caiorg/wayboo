import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';

vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../src/lib/store', () => {
  const state = { apiUrl: 'http://x', userId: 'u1', credentials: { 'http://x': { token: 't', userId: 'u1' } }, set: () => {}, setCredential: () => {} };
  return {
    normalizeApiUrl: (u: string) => u.replace(/\/$/, ''),
    settingsHydration: Promise.resolve(null),
    settingsSaved: async () => {},
    timeZone: () => 'UTC',
    useSettings: { getState: () => state, persist: { hasHydrated: () => true } },
  };
});

/** Resposta 200 cujo corpo vem de `json`. */
const ok = (json: () => Promise<unknown>) => ({ ok: true, status: 200, json }) as unknown as Response;

describe('leitura da resposta', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('devolve o JSON da resposta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(async () => ({ tables: {} }))));
    await expect(api.exportMyData()).resolves.toEqual({ tables: {} });
  });

  it('o timeout também vale para a leitura do corpo', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        ok(() => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
      ),
    );
    let settled = false;
    const p = api.exportMyData().finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // A leitura abortada cai no mesmo fallback de corpo inválido; `exportMyData` em exportData.ts recusa o `{}`.
    await expect(p).resolves.toEqual({});
  });

  it('alertas: corpo ilegível numa resposta 200 vira erro, não lista vazia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(async () => ({}))));
    await expect(api.alerts({ minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 })).rejects.toMatchObject({ status: 0 });
  });

  it('voto: corpo ilegível numa resposta 200 vira erro, não confirmação', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(async () => ({}))));
    await expect(api.vote('a1', true)).rejects.toMatchObject({ status: 0 });
  });

  it('erro HTTP usa a mensagem do servidor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Erro interno' }) }) as unknown as Response));
    await expect(api.exportMyData()).rejects.toMatchObject({ status: 500, message: 'Erro interno' });
  });
});
