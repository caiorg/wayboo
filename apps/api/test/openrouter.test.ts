import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// Importado já na fase de import, sem prazo: o primeiro `plannerWith` só reavalia o código já transformado, e o
// teste não paga a transformação do planejador e do `@wayboo/core` dentro dos 5 s.
import '../src/ai/planner';
import { openRouterProvider, openRouterStructuredOutputSupport } from '../src/ai/providers';
// O provedor importa o SDK na primeira chamada. Aqui ele carrega na fase de import, fora do prazo do primeiro teste.
import 'openai';
import 'openai/helpers/zod';
import 'openai/lib/parser';

const MODEL = 'openai/gpt-4o-mini';
const KEY = 'sk-or-test';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const catalog = (params: string[][]) =>
  json({ data: { id: MODEL, endpoints: params.map((supported_parameters, i) => ({ provider_name: `p${i}`, supported_parameters })) } });

const completion = (content: string) =>
  json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
  });

type Call = { url: string; headers: Headers; body: any; redirect?: RequestRedirect };

/** Simula o OpenRouter: catálogo de endpoints e chat completions. Nenhuma chamada sai da máquina. */
function fakeOpenRouter(opts: { catalog: () => Response; content: string; chat?: () => Response }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null, redirect: init?.redirect });
    if (url.endsWith('/endpoints')) return opts.catalog();
    if (url.endsWith('/chat/completions')) return opts.chat?.() ?? completion(opts.content);
    return json({ error: { code: 404, message: 'Not Found' } }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** Erro depois do cabeçalho: HTTP 200 só com `error` no topo, sem `choices` (docs de erros do OpenRouter). */
const errorOnly = (code: number, message: string) => () => json({ id: 'gen-2', error: { code, message, metadata: { flagged_input: 'oi' } } });

/** Erro no meio da geração: conteúdo parcial e `choices[0].error`, com HTTP 200. */
const choiceError = (code: number, message: string) => () =>
  json({
    id: 'gen-3',
    object: 'chat.completion',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, finish_reason: 'error', message: { role: 'assistant', content: '{"head', refusal: null }, error: { code, message } }],
  });

const Schema = z.object({ headline: z.string(), warnings: z.array(z.string()) });
const args = { system: 'sys', prompt: 'oi', schema: Schema, schemaName: 'route_brief' };

describe('openRouterProvider', () => {
  it('envia saída estruturada, cabeçalhos e exige provedor compatível', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['response_format', 'structured_outputs']]), content: '{"headline":"ok","warnings":[]}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: [] });
    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: [] });

    const [check, chat] = or.calls;
    expect(check!.url).toBe(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`);
    expect(chat!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chat!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(chat!.headers.get('http-referer')).toBe('https://github.com/caiorg/wayboo');
    expect(chat!.headers.get('x-openrouter-title')).toBe('Wayboo');
    expect(chat!.body).toMatchObject({
      model: MODEL,
      provider: { require_parameters: true, data_collection: 'deny' },
      response_format: { type: 'json_schema', json_schema: { name: 'route_brief', strict: true } },
    });
    // Nenhuma requisição segue redirecionamento.
    expect(or.calls.every((c) => c.redirect === 'error')).toBe(true);
    // O catálogo é consultado uma vez só.
    expect(or.calls.filter((c) => c.url.endsWith('/endpoints'))).toHaveLength(1);
    expect(or.calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(2);
  });

  it('desiste sem chamar o modelo quando nenhum endpoint tem saída estruturada', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['temperature', 'response_format'], ['tools']]), content: '{}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    await expect(p.generateObject(args)).rejects.toThrow(/saída estruturada/);
    expect(or.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('segue para o modelo quando o catálogo não responde', async () => {
    const or = fakeOpenRouter({ catalog: () => json({ error: { code: 502, message: 'down' } }, 502), content: '{"headline":"ok","warnings":["a"]}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: ['a'] });
  });

  it('trata catálogo malformado como indisponível', async () => {
    // String no lugar de array: `includes` acharia "structured_outputs" como substring.
    const malformed = () => json({ data: { endpoints: [{ supported_parameters: 'not_structured_outputs' }] } });
    const or = fakeOpenRouter({ catalog: malformed, content: '{"headline":"ok","warnings":[]}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: [] });
    expect(or.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true);
  });

  it('não segue redirecionamento 307/308 para outro servidor', async () => {
    // Servidores locais de verdade: o fetch nativo seguiria o redirect se a opção faltasse.
    const listen = (handler: Parameters<typeof createServer>[1]) =>
      new Promise<Server>((resolve) => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
    const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const received: string[] = [];
    const target = await listen((req, res) => {
      received.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.end('{}');
    });
    const origin = await listen((req, res) => {
      res.writeHead(req.url?.endsWith('/endpoints') ? 307 : 308, { location: `${urlOf(target)}${req.url}` });
      res.end();
    });
    try {
      const baseURL = `${urlOf(origin)}/api/v1`;
      expect(await openRouterStructuredOutputSupport(MODEL, { apiKey: KEY, baseURL })).toBeNull();
      await expect(openRouterProvider({ model: MODEL, apiKey: KEY, baseURL }).generateObject(args)).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      origin.close();
      target.close();
    }
  });

  it('repassa o erro de `choices[0].error` devolvido com HTTP 200', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['structured_outputs']]), content: '', chat: choiceError(502, 'Provider returned error') });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    await expect(p.generateObject(args)).rejects.toThrow('Erro do provedor 502: Provider returned error');
  });

  it('recusa AI_BASE_URL em http:// fora de loopback', () => {
    expect(() => openRouterProvider({ model: MODEL, apiKey: KEY, baseURL: 'http://proxy.example.com/v1' })).toThrow(/https/);
    expect(() => openRouterProvider({ model: MODEL, apiKey: KEY, baseURL: 'http://localhost:8080/v1' })).not.toThrow();
  });
});

describe('validação do ambiente de IA', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function configWith(vars: Record<string, string>) {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_MODEL', MODEL);
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    vi.resetModules();
    return import('../src/config');
  }

  it('recusa chave ou modelo só com espaços', async () => {
    await expect(configWith({ OPENROUTER_API_KEY: '   ' })).rejects.toThrow(/OPENROUTER_API_KEY/);
    await expect(configWith({ AI_MODEL: '   ' })).rejects.toThrow(/AI_MODEL/);
  });

  it('recusa AI_BASE_URL inválida sem expor a chave', async () => {
    const err = await configWith({ AI_BASE_URL: 'nao-e-url' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/AI_BASE_URL/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('AI_PROVIDER=openrouter no planejador', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function plannerWith(or: ReturnType<typeof fakeOpenRouter>) {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_MODEL', MODEL);
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    vi.stubGlobal('fetch', or.fetch);
    vi.resetModules();
    return import('../src/ai/planner');
  }

  const intent = {
    destinationQuery: 'Parque Ibirapuera',
    destinationPlace: null,
    avoidTolls: true,
    avoidHighways: false,
    avoidFerries: false,
    stops: [],
    arriveBy: null,
    departAt: null,
    priority: null,
  };

  it('interpreta o pedido com o modelo', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['structured_outputs']]), content: JSON.stringify(intent) });
    const { parseIntent } = await plannerWith(or);

    const res = await parseIntent('ir pro Ibirapuera sem pedágio', () => {});
    expect(res.provider).toBe('ia');
    expect(res.intent).toMatchObject({ destinationQuery: 'Parque Ibirapuera', avoidTolls: true });
  });

  it('cai no modo regras quando o modelo não tem saída estruturada', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['tools']]), content: JSON.stringify(intent) });
    const { parseIntent } = await plannerWith(or);
    const log = vi.fn();

    const res = await parseIntent('ir pro Ibirapuera sem pedágio', log);
    expect(res.provider).toBe('regras');
    expect(res.intent.avoidTolls).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('openrouter'));
    expect(or.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('cai no modo regras e registra a mensagem do erro devolvido com HTTP 200', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['structured_outputs']]), content: '', chat: errorOnly(429, 'Rate limit exceeded upstream') });
    const { parseIntent } = await plannerWith(or);
    const log = vi.fn();

    const res = await parseIntent('ir pro Ibirapuera sem pedágio', log);
    expect(res.provider).toBe('regras');
    expect(res.intent.avoidTolls).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = log.mock.calls[0]![0] as string;
    expect(msg).toContain('Erro do provedor 429: Rate limit exceeded upstream');
    // Nem a chave nem o prompt (nem o `metadata`, que pode trazer trecho dele) vão para o log.
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('Ibirapuera');
    expect(msg).not.toContain('flagged_input');
  });
});
