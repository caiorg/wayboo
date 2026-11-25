import type {
  AssistantResponse,
  Brief,
  FinishTripResponse,
  Insights,
  LatLon,
  PlanRequest,
  PlanResponse,
  Privacy,
  RoadAlert,
  Suggestion,
  TraceSample,
} from '@wayboo/core';
import { getRandomBytes } from 'expo-crypto';
import { readAiKey } from './aiKey';
import { normalizeApiUrl, settingsHydration, settingsSaved, timeZone, useSettings } from './store';

export interface GeocodeResult {
  name: string;
  label: string;
  lat: number;
  lon: number;
  category: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Valor cru do cabeçalho `Retry-After` de uma resposta 429. */
    public retryAfter: string | null = null,
  ) {
    super(message);
  }
}

/** `POST /auth/device` respondeu 429: o app não registra de novo neste servidor antes de `retryAt`. */
export class RegistrationLimitError extends ApiError {
  constructor(public retryAt: number) {
    const s = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    super(429, `Muitos registros desta rede. Tente de novo em ${s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`}.`);
  }
}

/** Espera padrão quando o 429 vem sem `Retry-After` legível. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** `Retry-After` em segundos ou como data HTTP (RFC 9110), convertido em instante absoluto. */
function retryAt(header: string | null): number {
  const now = Date.now();
  const v = header?.trim() ?? '';
  if (/^\d+$/.test(v)) return now + Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? now + DEFAULT_RETRY_AFTER_MS : Math.max(now, date);
}

/** Problema com a chave de IA própria: ausente do aparelho, servidor sem HTTPS ou recusada pelo provedor (422). */
export class AiKeyError extends ApiError {}

/** O servidor já apagou os dados, mas o aparelho não salvou a identidade nova. Não repetir o `DELETE /me`. */
export class LocalSaveError extends Error {}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `baseUrl` vem de quem chama: o token só vai para o servidor em que foi registrado. */
async function send<T>(
  baseUrl: string,
  method: Method,
  path: string,
  body: unknown,
  timeoutMs: number,
  token: string | null,
  extra: Record<string, string> = {},
): Promise<T> {
  // AbortSignal.timeout não existe em todas as versões do Hermes.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  let data: { error?: string };
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-time-zone': timeZone(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    // O corpo pode chegar depois dos cabeçalhos: o timeout vale até terminar a leitura.
    data = (await res.json().catch(() => ({}))) as { error?: string };
  } catch {
    throw new ApiError(0, `Sem conexão com o servidor (${baseUrl}). Confira a URL em Ajustes.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const retryAfter = res.status === 429 ? (res.headers?.get('retry-after') ?? null) : null;
    throw new ApiError(res.status, data.error ?? `Erro ${res.status}`, retryAfter);
  }
  return data as T;
}

const currentUrl = () => normalizeApiUrl(useSettings.getState().apiUrl);

const incompleteResponse = () => new ApiError(0, 'Resposta incompleta do servidor. Tente de novo.');

/** O AsyncStorage carrega depois do primeiro render; sem esperar, o app registraria um usuário novo. */
async function hydrated(): Promise<void> {
  if (useSettings.persist.hasHydrated()) return;
  // Leitura falhou ou JSON corrompido: erro tratável em vez de travar a chamada ou criar outra identidade.
  if ((await settingsHydration) !== null) throw new ApiError(0, 'Não foi possível ler os ajustes salvos neste aparelho.');
}

/** 32 bytes aleatórios em base64url (43 caracteres), o formato que o servidor aceita. */
function newToken(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = getRandomBytes(32);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < bytes.length ? abc[(n >> 6) & 63]! : '') + (i + 2 < bytes.length ? abc[n & 63]! : '');
  }
  return out;
}

/** A identidade em que a chamada começou foi descartada por `deleteMyData`. */
const identityReset = () => new ApiError(0, 'Os dados deste aparelho foram apagados durante a chamada. Tente de novo.');

/** O token foi revogado em outro aparelho, e este passou a ser um usuário novo. */
const deviceRevoked = () =>
  new ApiError(401, 'Este aparelho foi desconectado em outro aparelho e agora é um usuário novo, sem o histórico. Tente de novo.');

/**
 * Um registro em andamento por servidor; nunca compartilhado entre URLs. `userId` é o id local
 * quando o registro começou: depois de `resetIdentity`, o registro antigo não vale mais.
 */
const registering = new Map<string, { userId: string; token: Promise<string> }>();

/** Instante a partir do qual o servidor aceita um novo registro, depois de um 429. Vale por servidor. */
const registerBlockedUntil = new Map<string, number>();

/**
 * Token deste aparelho para `baseUrl`. Sem registro confirmado, grava um token novo (ou reusa o
 * gravado) e o registra. O registro é idempotente, então repetir após uma resposta perdida
 * devolve o mesmo usuário. Envia o `userId` local para o servidor adotar os dados já gravados nele.
 * Token revogado em outro aparelho: o servidor nunca mais o aceita. O aparelho troca de id (como
 * depois de apagar os dados), grava um token novo e o registra como usuário novo. A chamada em curso
 * era do usuário antigo e falha em vez de seguir com o novo; as próximas usam a credencial nova.
 */
async function deviceToken(baseUrl: string): Promise<string> {
  await hydrated();
  const saved = useSettings.getState().credentials[baseUrl];
  if (saved?.userId) return saved.token;
  const localId = useSettings.getState().userId;
  const pending = registering.get(baseUrl);
  if (pending?.userId === localId) return pending.token;
  const blockedUntil = registerBlockedUntil.get(baseUrl);
  if (blockedUntil !== undefined && Date.now() < blockedUntil) throw new RegistrationLimitError(blockedUntil);
  registerBlockedUntil.delete(baseUrl);
  const token = saved?.token ?? newToken();
  if (!saved) useSettings.getState().setCredential(baseUrl, { token });
  const register = (t: string, legacyUserId: string) =>
    send<{ userId: string }>(baseUrl, 'POST', '/auth/device', { token: t, legacyUserId }, 15000, null);
  const entry = {
    userId: localId,
    token: register(token, localId)
      .catch(async (e: unknown): Promise<never> => {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        if (useSettings.getState().userId !== localId) throw identityReset();
        useSettings.getState().resetIdentity(baseUrl);
        const newId = useSettings.getState().userId;
        const fresh = newToken();
        useSettings.getState().setCredential(baseUrl, { token: fresh });
        const { userId } = await register(fresh, newId);
        if (useSettings.getState().userId === newId) useSettings.getState().setCredential(baseUrl, { token: fresh, userId });
        throw deviceRevoked();
      })
      .then(({ userId }) => {
        // Resposta que chega depois de apagar os dados: o token descartado não grava nem é usado.
        if (useSettings.getState().userId !== localId) throw identityReset();
        useSettings.getState().setCredential(baseUrl, { token, userId });
        return token;
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError) || e.status !== 429) throw e;
        const until = retryAt(e.retryAfter);
        registerBlockedUntil.set(baseUrl, until);
        throw new RegistrationLimitError(until);
      })
      .finally(() => {
        if (registering.get(baseUrl) === entry) registering.delete(baseUrl);
      }),
  };
  registering.set(baseUrl, entry);
  return entry.token;
}

/** HTTP só em loopback (proxy local, `10.0.2.2` do emulador Android): fora disso, a chave atravessaria a rede aberta. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '10.0.2.2']);

function secureUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Cabeçalhos da chave de IA própria. Sem escolha em Ajustes, nenhum: o servidor usa o provedor dele. Com escolha e sem
 * chave no aparelho, erro em vez de cair calado na IA do servidor.
 */
async function aiHeaders(baseUrl: string): Promise<Record<string, string>> {
  const ai = useSettings.getState().ai;
  if (!ai) return {};
  if (!secureUrl(baseUrl))
    throw new AiKeyError(0, 'A chave de IA própria só é enviada por HTTPS. Use um servidor https:// ou volte para a IA do servidor em Ajustes.');
  const key = await readAiKey().catch(() => null);
  if (!key) throw new AiKeyError(0, 'A chave de IA própria não está neste aparelho. Cadastre de novo em Ajustes ou volte para a IA do servidor.');
  return { 'x-ai-provider': ai.provider, 'x-ai-model': ai.model, 'x-ai-key': key };
}

/** `ai`: rota de IA, que leva a chave própria quando há uma; o 422 dela é erro da chave, do crédito ou do modelo. */
async function request<T>(method: Method, path: string, body?: unknown, timeoutMs = 25000, ai = false): Promise<T> {
  const baseUrl = currentUrl();
  await hydrated();
  // Antes da hidratação, o `userId` em memória é o padrão; por isso a leitura vem depois dela.
  const localId = useSettings.getState().userId;
  // Antes do registro do aparelho: sem HTTPS ou sem chave, a chamada falha sem sair do aparelho.
  const extra = ai ? await aiHeaders(baseUrl) : {};
  const token = await deviceToken(baseUrl);
  if (useSettings.getState().userId !== localId) throw identityReset();
  try {
    return await send<T>(baseUrl, method, path, body, timeoutMs, token, extra);
  } catch (e) {
    if (ai && e instanceof ApiError && e.status === 422) throw new AiKeyError(422, e.message);
    // Token recusado (banco do servidor recriado, por exemplo): registra o mesmo token de novo, uma vez.
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    if (useSettings.getState().credentials[baseUrl]?.token === token) useSettings.getState().setCredential(baseUrl, { token });
    const retryToken = await deviceToken(baseUrl);
    // Depois de apagar os dados, a operação da identidade antiga não vai para a nova. Testa depois
    // de obter o token: o reset pode acontecer enquanto `deviceToken` espera.
    if (useSettings.getState().userId !== localId) throw identityReset();
    return send<T>(baseUrl, method, path, body, timeoutMs, retryToken, extra);
  }
}

/** Resposta de `GET /me/export`: as linhas de cada tabela ligadas ao usuário. */
export interface UserDataExport {
  userId: string;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** Um aparelho ativo do usuário em `GET /devices`. */
export interface DeviceInfo {
  id: string;
  createdAt: string;
  /** `null` em aparelhos registrados antes de o servidor guardar o último uso. */
  lastSeenAt: string | null;
  /** O aparelho que fez a chamada. */
  current: boolean;
}

export interface Health {
  ok: boolean;
  ai: { provider: string; model: string } | null;
  /** Provedores aceitos com a chave do usuário; ausente em servidores anteriores ao BYOK. */
  byok?: string[];
  /** Ausente em servidores anteriores ao self-host; `null` quando o servidor não serve mapa. */
  map?: { light: string; dark: string } | null;
}

export const api = {
  /** Também grava os estilos de mapa que o servidor anuncia; sem eles, o app usa os do OpenFreeMap. */
  health: async () => {
    const baseUrl = currentUrl();
    const h = await send<Health>(baseUrl, 'GET', '/health', undefined, 5000, null);
    // A URL pode ter mudado durante a chamada: a resposta só vale para o servidor que respondeu.
    if (currentUrl() === baseUrl) useSettings.getState().set({ serverMap: h.map ? { apiUrl: baseUrl, ...h.map } : null });
    return h;
  },
  geocode: (q: string, near?: LatLon) =>
    request<{ results: GeocodeResult[] }>(
      'GET',
      `/geocode?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`,
    ),
  reverse: (p: LatLon) => request<{ result: GeocodeResult | null }>('GET', `/reverse?lat=${p.lat}&lon=${p.lon}`),
  plan: (req: Omit<PlanRequest, 'timeZone'>) => request<PlanResponse>('POST', '/plan', { ...req, timeZone: timeZone() }),
  brief: (planId: string) => request<Brief>('POST', `/plan/${planId}/brief`, {}, 30000, true),
  assistant: (text: string, origin: LatLon) =>
    request<AssistantResponse>('POST', '/assistant', { text, origin, timeZone: timeZone() }, 45000, true),
  suggestions: (p: LatLon) => request<{ suggestions: Suggestion[] }>('GET', `/suggestions?lat=${p.lat}&lon=${p.lon}`, undefined, 30000),
  startTrip: (planId: string, routeIndex: number) =>
    request<{ tripId: string }>('POST', '/trips', { planId, routeIndex, timeZone: timeZone() }),
  samples: (tripId: string, samples: TraceSample[]) => request<{ stored: number }>('POST', `/trips/${tripId}/samples`, { samples }),
  reroute: (tripId: string, planId: string, routeIndex: number) =>
    request<{ seq: number }>('POST', `/trips/${tripId}/reroute`, { planId, routeIndex }),
  finishTrip: (tripId: string) => request<FinishTripResponse>('POST', `/trips/${tripId}/finish`, {}),
  // `send` devolve `{}` quando o corpo de um 2xx não pode ser lido (conexão caiu no meio da leitura).
  // Aqui isso vira erro: uma lista vazia apagaria os alertas do mapa, e um voto `{}` pareceria aceito.
  alerts: async (b: { minLat: number; minLon: number; maxLat: number; maxLon: number }) => {
    const r = await request<{ alerts?: RoadAlert[] }>('GET', `/alerts?minLat=${b.minLat}&minLon=${b.minLon}&maxLat=${b.maxLat}&maxLon=${b.maxLon}`);
    if (!Array.isArray(r.alerts)) throw incompleteResponse();
    return { alerts: r.alerts };
  },
  report: (type: RoadAlert['type'], p: LatLon) => request<RoadAlert>('POST', '/alerts', { type, lat: p.lat, lon: p.lon }),
  vote: async (id: string, up: boolean) => {
    const a = await request<Partial<RoadAlert>>('POST', `/alerts/${id}/vote`, { up });
    if (typeof a.id !== 'string') throw incompleteResponse();
    return a as RoadAlert;
  },
  insights: () => request<Insights>('GET', '/insights'),
  narrative: () => request<{ text: string | null; provider: string }>('POST', '/insights/narrative', {}, 40000, true),
  privacy: () => request<Privacy>('GET', '/privacy'),
  setPrivacy: (p: Privacy) => request<Privacy>('PUT', '/privacy', p),
  /** Todas as linhas deste usuário no servidor, menos o hash do token (docs/privacidade.md). */
  exportMyData: () => request<UserDataExport>('GET', '/me/export', undefined, 30000),
  /** Apaga tudo deste usuário no servidor. O aparelho troca de token e de id; a próxima chamada registra um usuário novo. */
  deleteMyData: async () => {
    const baseUrl = currentUrl();
    const res = await request<{ deleted: Record<string, number> }>('DELETE', '/me');
    useSettings.getState().resetIdentity(baseUrl);
    // Sem esperar, fechar o app agora restauraria o id antigo, e o servidor o adotaria de novo.
    await settingsSaved().catch(() => {
      throw new LocalSaveError('Dados apagados no servidor, mas não foi possível salvar o novo identificador neste aparelho.');
    });
    return res;
  },
  devices: () => request<{ devices: DeviceInfo[] }>('GET', '/devices'),
  /** Revoga outro aparelho do usuário. O servidor recusa o último aparelho ativo com 409. */
  revokeDevice: (id: string) => request<unknown>('DELETE', `/devices/${encodeURIComponent(id)}`),
  /**
   * Revoga o token deste aparelho e troca o id local; a próxima chamada registra um usuário novo.
   * O servidor recusa com 409 se este for o único aparelho ativo: o caminho é apagar os dados.
   */
  logout: async () => {
    const baseUrl = currentUrl();
    await hydrated();
    const localId = useSettings.getState().userId;
    await request<unknown>('POST', '/auth/logout', {});
    // Uma chamada concorrente pode já ter trocado a identidade (token revogado): a nova fica.
    if (useSettings.getState().userId === localId) useSettings.getState().resetIdentity(baseUrl);
    // Se a gravação falhar, o app reabre com o token revogado, leva 401 e registra um token novo.
    await settingsSaved().catch(() => {});
  },
  updatePlace: (id: string, patch: { kind?: 'home' | 'work' | 'other'; name?: string | null }) =>
    request<unknown>('PATCH', `/places/${id}`, patch),
};
