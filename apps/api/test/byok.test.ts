import { Writable } from 'node:stream';
import type { PlanResponse } from '@wayboo/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { db } from '../src/db';
import { client, makeRoute, type User } from './helpers';

const ROUTE = makeRoute();

vi.mock('../src/providers/routing', () => ({ valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] } }));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

/** Chaves com um trecho único (`QZXW9...`) para achar até um pedaço delas em log, banco ou resposta. */
const KEYS = {
  anthropic: 'sk-ant-api03-byok-QZXW9anthropic-0123456789abcdef',
  openai: 'sk-proj-byok-QZXW9openai-0123456789abcdefABCDEF',
  openrouter: 'sk-or-v1-byok-QZXW9openrouter-0123456789abcdef',
} as const;
type Provider = keyof typeof KEYS;
const MODELS: Record<Provider, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' };
const SERVER_KEY = 'sk-servidor-QZXW9-nao-pode-sair';
const FRAGMENT = 'QZXW9';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BRIEF = { recommendedIndex: 0, headline: 'Vá pela principal', explanation: 'Mais rápida.', warnings: [], departureAdvice: null };

const anthropicMessage = (out: object) =>
  json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODELS.anthropic,
    content: [{ type: 'text', text: JSON.stringify(out) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const chatCompletion = (out: object, model: string) =>
  json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out), refusal: null } }],
  });

/** Resposta de sucesso de cada provedor, no endpoint oficial. */
function ok(out: object) {
  return (full: string): Response => {
    // O SDK da Anthropic chama `/v1/messages?beta=true`.
    const url = full.split('?')[0]!;
    if (url === 'https://api.anthropic.com/v1/messages') return anthropicMessage(out);
    if (url === 'https://api.openai.com/v1/chat/completions') return chatCompletion(out, MODELS.openai);
    if (url === `https://openrouter.ai/api/v1/models/${MODELS.openrouter}/endpoints`)
      return json({ data: { endpoints: [{ supported_parameters: ['response_format', 'structured_outputs'] }] } });
    if (url === 'https://openrouter.ai/api/v1/chat/completions') return chatCompletion(out, MODELS.openrouter);
    return json({ error: 'fora do esperado' }, 599);
  };
}

/** Corpo de erro como cada provedor manda. A OpenAI ecoa parte da chave na mensagem do 401. */
function failing(status: number, provider: Provider) {
  return (url: string): Response => {
    if (url.endsWith('/endpoints')) return ok({})(url);
    const key = KEYS[provider];
    if (provider === 'anthropic')
      return json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${key}` }, request_id: 'req_1' }, status);
    if (provider === 'openai')
      return json(
        { error: { message: `Incorrect API key provided: ${key.slice(0, 3)}***${key.slice(-24)}.`, type: 'invalid_request_error', code: 'invalid_api_key' } },
        status,
      );
    return json({ error: { code: status, message: `Invalid credentials ${key}` } }, status);
  };
}

type AiCall = { url: string; headers: Headers; redirect?: RequestRedirect };
let calls: AiCall[] = [];
let reply: (url: string) => Response = ok(BRIEF);

const logs: string[] = [];
const consoleOut: string[] = [];

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  vi.stubEnv('LOG_LEVEL', 'trace');
  app = await buildApp({
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
  vi.unstubAllEnvs();
});
afterAll(() => app.close());

beforeEach(() => {
  calls = [];
  reply = ok(BRIEF);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
      return reply(url);
    }),
  );
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleOut.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const api = client(() => app, ROUTE);

const byok = (provider: string, key: string = KEYS[provider as Provider], model: string = MODELS[provider as Provider]) => ({
  'x-ai-provider': provider,
  'x-ai-key': key,
  'x-ai-model': model,
});

async function brief(user: User, headers: Record<string, string> = {}) {
  const p = (await api.call<PlanResponse>(user, 'POST', '/plan', api.planRequest)).body;
  calls = [];
  const res = await app.inject({ method: 'POST', url: `/plan/${p.planId}/brief`, headers: { authorization: `Bearer ${user.token}`, ...headers }, payload: {} });
  return { status: res.statusCode, body: res.json<{ provider?: string; model?: string | null; error?: string }>(), raw: res.body };
}

const authOf = (c: AiCall) => `${c.headers.get('authorization') ?? ''} ${c.headers.get('x-api-key') ?? ''}`;

describe('BYOK', () => {
  it('sem chave do usuário, usa o provedor padrão do servidor', async () => {
    const user = await api.register();
    const res = await brief(user);
    expect(res.status).toBe(200);
    // AI_PROVIDER=none nos testes: o padrão é o briefing por regras, sem chamar provedor.
    expect(res.body.provider).toBe('regras');
    expect(calls).toHaveLength(0);
  });

  it('/health anuncia os provedores aceitos com chave do usuário', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ byok: ['anthropic', 'openai', 'openrouter'] });
  });

  it.each(['anthropic', 'openai', 'openrouter'] as const)(
    '%s: usa a chave do usuário no endpoint oficial e não segue redirecionamento',
    async (provider) => {
      // Variáveis do servidor que não podem desviar a chave do usuário nem somar a credencial do servidor.
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://desvio.example');
      vi.stubEnv('ANTHROPIC_API_KEY', SERVER_KEY);
      vi.stubEnv('OPENAI_BASE_URL', 'https://desvio.example/v1');
      vi.stubEnv('OPENAI_API_KEY', SERVER_KEY);
      vi.stubEnv('OPENAI_ORG_ID', 'org-servidor');
      vi.stubEnv('OPENAI_PROJECT_ID', 'proj-servidor');
      // Os SDKs somam estes cabeçalhos a todo cliente, mesmo com `apiKey` explícito.
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', `x-api-key: ${SERVER_KEY}\ncf-aig-authorization: Bearer ${SERVER_KEY}`);
      vi.stubEnv('OPENAI_CUSTOM_HEADERS', `Authorization: Bearer ${SERVER_KEY}\nx-gateway: ${SERVER_KEY}`);
      const user = await api.register();

      const res = await brief(user, byok(provider));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ headline: BRIEF.headline, provider, model: MODELS[provider] });
      expect(calls.length).toBeGreaterThan(0);
      const origin = { anthropic: 'https://api.anthropic.com/', openai: 'https://api.openai.com/', openrouter: 'https://openrouter.ai/' }[provider];
      for (const c of calls) {
        expect(c.url.startsWith(origin)).toBe(true);
        expect(c.redirect).toBe('error');
        expect(authOf(c)).toContain(KEYS[provider]);
        expect(JSON.stringify([...c.headers])).not.toContain(SERVER_KEY);
        expect(c.headers.get('openai-organization')).toBeNull();
        expect(c.headers.get('openai-project')).toBeNull();
      }
    },
  );

  it('vale também para o assistente e para a narrativa do aprendizado', async () => {
    const user = await api.register();
    const auth = { authorization: `Bearer ${user.token}`, ...byok('openai') };

    reply = ok({
      destinationQuery: null,
      destinationPlace: 'home',
      avoidTolls: false,
      avoidHighways: false,
      avoidFerries: false,
      stops: [],
      arriveBy: null,
      departAt: null,
      priority: null,
    });
    const assistant = await app.inject({
      method: 'POST',
      url: '/assistant',
      headers: auth,
      payload: { text: 'me leva pra casa', origin: api.planRequest.origin, timeZone: 'America/Sao_Paulo' },
    });
    expect(assistant.statusCode).toBe(200);
    expect(assistant.json()).toMatchObject({ provider: 'ia' });
    expect(calls.at(-1)?.url).toBe('https://api.openai.com/v1/chat/completions');

    reply = ok({ text: 'Você sai às 8h.' });
    const narrative = await app.inject({ method: 'POST', url: '/insights/narrative', headers: auth, payload: {} });
    expect(narrative.statusCode).toBe(200);
    expect(narrative.json()).toEqual({ text: 'Você sai às 8h.', provider: 'ia' });
  });

  it.each([
    ['anthropic', 401, /chave de IA foi recusada pela Anthropic/],
    ['openai', 401, /chave de IA foi recusada pela OpenAI/],
    ['openrouter', 401, /chave de IA foi recusada pelo OpenRouter/],
    ['openai', 403, /não tem permissão para usar gpt-4o-mini/],
    ['openrouter', 402, /sem crédito/],
    ['anthropic', 404, /não encontrou o modelo claude-opus-5-5/],
  ] as const)('%s com HTTP %i: erro claro, sem cair nas regras e sem ecoar a chave', async (provider, status, message) => {
    reply = failing(status, provider);
    const user = await api.register();

    const res = await brief(user, byok(provider));

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(message);
    expect(res.body.error).toMatch(/Ajustes/);
    expect(res.raw).not.toContain(FRAGMENT);
    expect(res.raw).not.toContain('***');
  });

  it('o OpenRouter com erro de chave no corpo de um HTTP 200 também gera erro claro', async () => {
    reply = (url) => (url.endsWith('/endpoints') ? ok({})(url) : json({ id: 'gen-2', error: { code: 401, message: `User not found ${KEYS.openrouter}` } }));
    const user = await api.register();

    const res = await brief(user, byok('openrouter'));

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/recusada pelo OpenRouter/);
    expect(res.raw).not.toContain(FRAGMENT);
  });

  it('falha que não é da chave cai nas regras, sem usar a chave do servidor', async () => {
    reply = failing(400, 'openai');
    const user = await api.register();

    const res = await brief(user, byok('openai'));

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('regras');
    expect(calls.every((c) => c.url.startsWith('https://api.openai.com/'))).toBe(true);
  });

  it.each([
    ['provedor desconhecido', byok('ollama', KEYS.openai, 'llama3')],
    ['provedor sem chave', { 'x-ai-provider': 'openai', 'x-ai-model': 'gpt-4o-mini' }],
    ['chave sem provedor', { 'x-ai-key': KEYS.openai, 'x-ai-model': 'gpt-4o-mini' }],
    ['chave com espaço', byok('openai', `${KEYS.openai} x`)],
    ['chave curta', byok('openai', 'sk-QZXW9')],
    ['sem modelo', { 'x-ai-provider': 'openai', 'x-ai-key': KEYS.openai }],
    ['modelo com ..', byok('openrouter', KEYS.openrouter, '../../key')],
    ['modelo com ?', byok('openrouter', KEYS.openrouter, 'a?b=c')],
  ])('%s: 400 sem chamar o provedor e sem ecoar a chave', async (_name, headers) => {
    const user = await api.register();
    const res = await brief(user, headers as Record<string, string>);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-ai-/);
    expect(res.raw).not.toContain(FRAGMENT);
    expect(calls).toHaveLength(0);
  });

  it('limita as chamadas com chave do usuário por usuário', async () => {
    reply = ok({ text: 'ok' });
    const user = await api.register();
    const narrative = () =>
      app.inject({ method: 'POST', url: '/insights/narrative', headers: { authorization: `Bearer ${user.token}`, ...byok('openai') }, payload: {} });
    for (let i = 0; i < 20; i++) expect((await narrative()).statusCode).toBe(200);
    const limited = await narrative();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: string }>().error).toMatch(/chave de IA própria/);
    // Sem a chave do usuário, o limite não vale: o provedor do servidor segue disponível.
    const plain = await app.inject({ method: 'POST', url: '/insights/narrative', headers: { authorization: `Bearer ${user.token}` }, payload: {} });
    expect(plain.statusCode).toBe(200);
  });

  it('a chave não aparece em log, console, banco nem export', { timeout: 60_000 }, async () => {
    // Em `debug`, os SDKs imprimem no console o corpo das respostas de erro.
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('OPENAI_LOG', 'debug');
    const user = await api.register();
    for (const provider of ['anthropic', 'openai', 'openrouter'] as const) {
      reply = ok(BRIEF);
      await brief(user, byok(provider));
      for (const status of [401, 400, 500]) {
        reply = failing(status, provider);
        await brief(user, byok(provider));
      }
    }

    const exported = await app.inject({ method: 'GET', url: '/me/export', headers: { authorization: `Bearer ${user.token}` } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(FRAGMENT);

    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    const dump = JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM "${t.name}"`).all()));
    expect(dump).not.toContain(FRAGMENT);

    // Log de todo o arquivo, inclusive dos erros 401 que ecoam a chave e das recusas de cabeçalho.
    expect(logs.join('').length).toBeGreaterThan(0);
    expect(logs.join('')).toMatch(/IA do usuário indisponível/);
    expect(logs.join('')).not.toContain(FRAGMENT);
    expect(consoleOut.join('\n')).not.toContain(FRAGMENT);
  });
});
