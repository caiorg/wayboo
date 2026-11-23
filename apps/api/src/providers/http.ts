import { config } from '../config';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 10000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { 'user-agent': config.userAgent, accept: 'application/json', ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede';
    throw new HttpError(502, `Serviço externo indisponível (${reason}): ${new URL(url).host}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status >= 500 ? 502 : res.status, `${new URL(url).host} respondeu ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Cache em memória com TTL, para respeitar a política de uso dos serviços públicos. */
export function ttlCache<V>(ttlMs: number, max = 2000) {
  const map = new Map<string, { v: V; exp: number }>();
  return {
    get(k: string): V | undefined {
      const e = map.get(k);
      if (!e) return undefined;
      if (e.exp < Date.now()) {
        map.delete(k);
        return undefined;
      }
      return e.v;
    },
    clear() {
      map.clear();
    },
    set(k: string, v: V) {
      if (map.size >= max) map.delete(map.keys().next().value!);
      map.set(k, { v, exp: Date.now() + ttlMs });
    },
  };
}
