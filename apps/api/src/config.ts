import { isIP } from 'node:net';
import { z } from 'zod';

const env = process.env;

/** Vazio ou só espaços conta como ausente; assim as checagens de obrigatório abaixo pegam `"   "`. */
const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

const AiEnv = z.object({
  AI_MODEL: optionalText,
  AI_BASE_URL: optionalText.pipe(z.url().optional()),
  OPENAI_API_KEY: optionalText,
  OLLAMA_API_KEY: optionalText,
  OPENROUTER_API_KEY: optionalText,
});

/** Número finito e positivo; vazio conta como ausente. */
const optionalPositive = optionalText.pipe(z.coerce.number<string>().positive().optional());

const SuggestionEnv = z.object({
  SUGGESTION_ROUTE_MAX_AGE_MIN: optionalPositive,
  SUGGESTION_ROUTE_RADIUS_M: optionalPositive,
});

function parseEnv<T extends z.ZodType>(schema: T): z.output<T> {
  const r = schema.safeParse(env);
  if (r.success) return r.data;
  // Só o nome da variável: a mensagem não pode vazar a chave.
  const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  throw new Error(`Variável de ambiente inválida: ${names.join(', ')}`);
}

const aiEnv = parseEnv(AiEnv);
const suggestionEnv = parseEnv(SuggestionEnv);

/** Vazio conta como ausente (padrão 24); zero explícito vale e apaga na próxima rodada. */
const RetentionEnv = z.object({
  GPS_RETENTION_HOURS: optionalText.transform((v) => (v === undefined ? 24 : Number(v))).pipe(z.number().finite().nonnegative()),
});

const retentionEnv = parseEnv(RetentionEnv);

const PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

/** IP, CIDR (`10.0.0.0/8`) ou faixa nomeada do `proxy-addr` (`uniquelocal` cobre as redes privadas, como a do Docker). */
function isProxyAddr(s: string): boolean {
  if (PROXY_RANGES.includes(s)) return true;
  const [ip = '', bits, ...rest] = s.split('/');
  const v = isIP(ip);
  if (!v || rest.length) return false;
  return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128));
}

/**
 * Limite de `POST /auth/device` por IP. Vazio usa o padrão; `AUTH_DEVICE_RATE_LIMIT=0` desliga.
 * `TRUST_PROXY` lista, separados por vírgula, os proxies cujo `X-Forwarded-For` vale; vazio não confia em ninguém.
 * `true` e contagem de saltos não são aceitos: o primeiro confiaria no cabeçalho forjado pelo cliente, e o Fastify 5
 * ignora o segundo.
 */
const RateLimitEnv = z.object({
  AUTH_DEVICE_RATE_LIMIT: optionalText.transform((v) => (v === undefined ? 30 : Number(v))).pipe(z.number().int().nonnegative()),
  AUTH_DEVICE_RATE_WINDOW_MIN: optionalPositive,
  TRUST_PROXY: optionalText.transform((v, ctx): false | string[] => {
    if (v === undefined || v === 'false') return false;
    const list = v.split(',').map((s) => s.trim());
    if (list.every(isProxyAddr)) return list;
    ctx.addIssue({ code: 'custom', message: 'use uma lista de IPs, CIDRs ou faixas (loopback, linklocal, uniquelocal)' });
    return z.NEVER;
  }),
});

const rateLimitEnv = parseEnv(RateLimitEnv);

/** `off` desliga a consulta ao Photon que identifica estado e município para os feriados regionais. */
const HolidayEnv = z.object({ REGIONAL_HOLIDAYS: optionalText.pipe(z.enum(['on', 'off']).optional()) });
const holidayEnv = parseEnv(HolidayEnv);

export type AiProviderName = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'none';

const PROVIDERS: readonly AiProviderName[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'none'];

function detectProvider(): AiProviderName {
  const explicit = env.AI_PROVIDER?.toLowerCase();
  if (explicit && (PROVIDERS as readonly string[]).includes(explicit)) return explicit as AiProviderName;
  if (explicit) throw new Error(`AI_PROVIDER inválido: ${explicit} (use ${PROVIDERS.join(' | ')})`);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (aiEnv.OPENAI_API_KEY) return 'openai';
  if (aiEnv.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

const provider = detectProvider();

const DEFAULT_BASE_URL: Partial<Record<AiProviderName, string>> = {
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const API_KEY: Partial<Record<AiProviderName, string | undefined>> = {
  openai: aiEnv.OPENAI_API_KEY,
  ollama: aiEnv.OLLAMA_API_KEY ?? 'ollama',
  openrouter: aiEnv.OPENROUTER_API_KEY,
};

/** Estilos do mapa no servidor próprio, anunciados em `/health`. Sem `MAP_STYLE_URL`, o app usa os do OpenFreeMap. */
const MapEnv = z.object({
  MAP_STYLE_URL: optionalText.pipe(z.url().optional()),
  MAP_STYLE_DARK_URL: optionalText.pipe(z.url().optional()),
});
const mapEnv = MapEnv.parse(env);

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dbPath: env.DB_PATH ?? 'wayboo.db',
  userAgent: env.USER_AGENT ?? 'Wayboo/0.1 (+https://github.com/caiorg/wayboo)',
  valhallaUrl: (env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de').replace(/\/$/, ''),
  photonUrl: (env.PHOTON_URL ?? 'https://photon.komoot.io').replace(/\/$/, ''),
  openMeteoUrl: (env.OPEN_METEO_URL ?? 'https://api.open-meteo.com').replace(/\/$/, ''),
  mapStyles: mapEnv.MAP_STYLE_URL ? { light: mapEnv.MAP_STYLE_URL, dark: mapEnv.MAP_STYLE_DARK_URL ?? mapEnv.MAP_STYLE_URL } : null,
  corsOrigin: env.CORS_ORIGIN ?? true,
  /** `/suggestions` reaproveita a rota habitual guardada e só pede outra ao roteador quando ela fica velha ou o pedido sai do raio. */
  suggestions: {
    routeMaxAgeMs: (suggestionEnv.SUGGESTION_ROUTE_MAX_AGE_MIN ?? 24 * 60) * 60_000,
    /** Distância máxima entre o ponto atual (e o destino) e os pontos usados quando a rota foi guardada. */
    routeRadiusM: suggestionEnv.SUGGESTION_ROUTE_RADIUS_M ?? 250,
  },
  /** Horas que o rastro GPS de uma viagem encerrada fica no servidor. Ver docs/privacidade.md. */
  gpsRetentionHours: retentionEnv.GPS_RETENTION_HOURS,
  /** Registros de aparelho por IP (IPv6 por /64) a cada janela. `max` 0 desliga. */
  authDeviceRateLimit: {
    max: rateLimitEnv.AUTH_DEVICE_RATE_LIMIT,
    windowMs: (rateLimitEnv.AUTH_DEVICE_RATE_WINDOW_MIN ?? 60) * 60_000,
  },
  /** Feriados estaduais e municipais no ETA, com a região vinda do reverse do Photon. */
  regionalHolidays: holidayEnv.REGIONAL_HOLIDAYS !== 'off',
  /** Repassado ao `trustProxy` do Fastify; define de onde vem `req.ip`. */
  trustProxy: rateLimitEnv.TRUST_PROXY,
  ai: {
    provider,
    model: aiEnv.AI_MODEL ?? (provider === 'anthropic' ? 'claude-opus-5-5' : null),
    baseUrl: aiEnv.AI_BASE_URL ?? DEFAULT_BASE_URL[provider],
    apiKey: API_KEY[provider],
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 15000),
  },
};

if ((provider === 'openai' || provider === 'ollama' || provider === 'openrouter') && !config.ai.model) {
  throw new Error(
    `AI_MODEL é obrigatório para AI_PROVIDER=${provider} (ex.: o nome do modelo instalado no Ollama ou "openai/gpt-4o-mini" no OpenRouter).`,
  );
}
if (provider === 'openrouter' && !config.ai.apiKey) throw new Error('OPENROUTER_API_KEY é obrigatório para AI_PROVIDER=openrouter.');
// O cliente da OpenAI lançaria o mesmo erro, mas só na primeira chamada, porque o SDK é carregado sob demanda.
if (provider === 'openai' && !config.ai.apiKey) throw new Error('OPENAI_API_KEY é obrigatório para AI_PROVIDER=openai.');
