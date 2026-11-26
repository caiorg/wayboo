import { z } from 'zod';
import { config } from '../config';

/**
 * Abstração mínima de LLM: só geração de objeto estruturado validado por zod.
 * É tudo que o planejador precisa, e mantém os adaptadores pequenos.
 */
export interface LlmProvider {
  name: string;
  model: string;
  generateObject<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; schemaName: string }): Promise<z.infer<S>>;
  /**
   * Provedor com a chave do usuário (BYOK). `configError` converte o erro de chave, crédito ou modelo num erro para o
   * usuário; `summary` descreve a falha para o log sem o texto do provedor, que pode ecoar parte da chave.
   */
  userKey?: { configError(e: unknown): Error | null; summary(e: unknown): string };
}

/** `status`: código HTTP do erro, também quando o OpenRouter o manda no corpo de um HTTP 200. */
export class AiError extends Error {
  override name = 'AiError';
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof globalThis.fetch;

/**
 * Memoiza `load`. Se falhar, a próxima chamada tenta de novo.
 * Os SDKs só são importados na primeira chamada: sem IA configurada, o servidor e os testes não pagam o import.
 */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () =>
    (p ??= load().catch((e: unknown) => {
      p = undefined;
      throw e;
    }));
}

/**
 * Sem `apiKey`, o SDK resolve ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou o perfil do `ant auth login`. Com `apiKey`,
 * o SDK não lê nenhuma credencial do ambiente; com `baseURL`, ignora ANTHROPIC_BASE_URL.
 */
export function anthropicProvider(model: string, opts: { apiKey?: string; baseURL?: string; fetch?: Fetch; logLevel?: 'off' } = {}): LlmProvider {
  const client = lazy(async () => {
    const [{ default: Sdk }, { betaZodOutputFormat }] = await Promise.all([import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/helpers/beta/zod')]);
    return { sdk: new Sdk({ ...opts, timeout: config.ai.timeoutMs, maxRetries: 1 }), betaZodOutputFormat };
  });
  return {
    name: 'anthropic',
    model,
    async generateObject({ system, prompt, schema }) {
      const { sdk, betaZodOutputFormat } = await client();
      const res = await sdk.beta.messages.parse({
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: prompt }],
        // Esforço baixo: a decisão é curta e a resposta precisa chegar antes do motorista sair.
        output_config: { format: betaZodOutputFormat(schema), effort: 'low' },
        // Se um classificador recusar, o servidor reexecuta no modelo de fallback recomendado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (res.stop_reason === 'refusal') throw new AiError('O modelo recusou a solicitação');
      if (res.parsed_output == null) throw new AiError(`Resposta sem JSON válido (stop_reason=${res.stop_reason})`);
      return res.parsed_output as z.infer<typeof schema>;
    },
  };
}

interface OpenAiCompatibleOptions {
  name: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  /** Campos do corpo fora do schema da OpenAI (ex.: `provider` do OpenRouter). */
  extraBody?: Record<string, unknown>;
  fetch?: Fetch;
  /** Roda antes de cada chamada; lança para desistir sem gastar a requisição. */
  preflight?: () => Promise<void>;
  /** Não lê `OPENAI_*` do ambiente: com a chave do usuário, a organização e o projeto do servidor não vão junto. */
  ignoreEnv?: boolean;
  /** `off` cala o log do SDK, que em `debug` imprime o corpo das respostas de erro. */
  logLevel?: 'off';
}

const BodyError = z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string() });
const ErrorEnvelope = z.object({ error: BodyError.optional(), choices: z.array(z.object({ error: BodyError.optional() })).optional() });

/**
 * O OpenRouter pode responder HTTP 200 com o erro no corpo: `error` no topo (sem `choices`) ou `choices[0].error`
 * (https://openrouter.ai/docs/api-reference/errors). Só código e mensagem: `metadata` pode trazer trecho do prompt.
 */
function bodyError(res: unknown): AiError | null {
  const parsed = ErrorEnvelope.safeParse(res);
  const err = parsed.success ? (parsed.data.error ?? parsed.data.choices?.[0]?.error) : undefined;
  if (!err) return null;
  const status = typeof err.code === 'number' && Number.isInteger(err.code) ? err.code : undefined;
  return new AiError(`Erro do provedor${err.code == null ? '' : ` ${err.code}`}: ${err.message.slice(0, 300)}`, status);
}

/** OpenAI e qualquer servidor compatível (Ollama, vLLM, LM Studio, OpenRouter) via `baseURL`. */
export function openAiCompatibleProvider(o: OpenAiCompatibleOptions): LlmProvider {
  const client = lazy(async () => {
    const [{ default: Sdk }, { zodResponseFormat }, { parseChatCompletion }] = await Promise.all([
      import('openai'),
      import('openai/helpers/zod'),
      import('openai/lib/parser'),
    ]);
    const sdk = new Sdk({
      ...(o.ignoreEnv ? { organization: null, project: null, adminAPIKey: null } : {}),
      ...(o.logLevel ? { logLevel: o.logLevel } : {}),
      apiKey: o.apiKey,
      baseURL: o.baseURL,
      defaultHeaders: o.defaultHeaders,
      fetch: o.fetch,
      timeout: config.ai.timeoutMs,
      maxRetries: 1,
    });
    return { sdk, zodResponseFormat, parseChatCompletion };
  });
  return {
    name: o.name,
    model: o.model,
    async generateObject({ system, prompt, schema, schemaName }) {
      await o.preflight?.();
      const { sdk, zodResponseFormat, parseChatCompletion } = await client();
      const body = {
        ...o.extraBody,
        model: o.model,
        messages: [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: prompt },
        ],
        response_format: zodResponseFormat(schema, schemaName),
      };
      // `create` + `parseChatCompletion` em vez de `parse`: o erro no corpo precisa ser lido antes do parser do SDK.
      const res = await sdk.chat.completions.create(body);
      const err = bodyError(res);
      if (err) throw err;
      const msg = parseChatCompletion(res, body).choices[0]?.message;
      if (msg?.refusal) throw new AiError(`O modelo recusou: ${msg.refusal}`);
      if (msg?.parsed == null) throw new AiError('Resposta sem JSON válido');
      return msg.parsed as z.infer<typeof schema>;
    },
  };
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Cabeçalhos opcionais de atribuição do app (https://openrouter.ai/docs/api-reference/overview). */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/caiorg/wayboo', 'X-OpenRouter-Title': 'Wayboo' };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A chave vai no cabeçalho `Authorization`: só aceita HTTPS, ou HTTP em loopback (proxy local). */
function assertSecureBaseUrl(baseURL: string) {
  const url = new URL(baseURL);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return;
  throw new AiError('AI_BASE_URL do OpenRouter precisa usar https:// (http:// só em localhost)');
}

/** Só o que o preflight lê de `GET /models/{id}/endpoints`; formato diferente conta como catálogo indisponível. */
const EndpointsCatalog = z.object({
  data: z.object({ endpoints: z.array(z.object({ supported_parameters: z.array(z.string()).optional() })) }),
});

/**
 * Consulta `GET /models/{id}/endpoints`: o suporte a saída estruturada varia por endpoint (provedor) do modelo.
 * Retorna `null` quando o catálogo não responde; aí a chamada segue e `require_parameters` decide.
 */
export async function openRouterStructuredOutputSupport(
  model: string,
  opts: { apiKey?: string; baseURL?: string; fetch?: Fetch } = {},
): Promise<boolean | null> {
  const { apiKey, baseURL = OPENROUTER_BASE_URL, fetch: fetchImpl = globalThis.fetch } = opts;
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/models/${model}/endpoints`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(config.ai.timeoutMs),
      // Redirect levaria a chave a um destino não validado; o erro cai no catch e conta como catálogo indisponível.
      redirect: 'error',
    });
    if (!res.ok) return null;
    const parsed = EndpointsCatalog.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data.endpoints.some((e) => e.supported_parameters?.includes('structured_outputs'));
  } catch {
    return null;
  }
}

/** OpenRouter via API compatível com a OpenAI. Exportado para reuso com chave do usuário. */
export function openRouterProvider(opts: { model: string; apiKey: string; baseURL?: string; fetch?: Fetch; logLevel?: 'off' }): LlmProvider {
  const { model, apiKey, baseURL = OPENROUTER_BASE_URL, fetch: baseFetch = globalThis.fetch, logLevel } = opts;
  assertSecureBaseUrl(baseURL);
  // A API não redireciona; seguir um 307/308 reenviaria chave e prompt para um destino não validado (talvez http://).
  const fetchImpl: Fetch = (input, init) => baseFetch(input, { ...init, redirect: 'error' });
  let support: Promise<boolean | null> | undefined;
  return openAiCompatibleProvider({
    name: 'openrouter',
    model,
    apiKey,
    baseURL,
    fetch: fetchImpl,
    // OPENAI_ORG_ID e OPENAI_PROJECT_ID são da OpenAI: não vão para o OpenRouter.
    ignoreEnv: true,
    logLevel,
    defaultHeaders: OPENROUTER_HEADERS,
    // `require_parameters`: sem isso o roteador pode mandar para um provedor que ignora `response_format`.
    // `data_collection: 'deny'`: o pedido pode ter endereços; só provedores que não guardam nem treinam com o prompt.
    extraBody: { provider: { require_parameters: true, data_collection: 'deny' } },
    async preflight() {
      support ??= openRouterStructuredOutputSupport(model, { apiKey, baseURL, fetch: fetchImpl });
      if ((await support) === false) throw new AiError(`${model} não tem saída estruturada em nenhum provedor do OpenRouter`);
    },
  });
}

function create(): LlmProvider | null {
  const { provider, model, baseUrl, apiKey } = config.ai;
  if (provider === 'none' || !model) return null;
  if (provider === 'anthropic') return anthropicProvider(model);
  if (provider === 'openrouter') return openRouterProvider({ model, apiKey: apiKey!, baseURL: baseUrl });
  return openAiCompatibleProvider({ name: provider, model, baseURL: baseUrl, apiKey });
}

export const llm = create();

/**
 * Executa com prazo; em falha retorna null para o chamador usar o caminho determinístico. `provider` omitido usa o do
 * servidor. Com a chave do usuário, erro de chave, crédito ou modelo sobe para ele em vez de cair nas regras.
 */
export async function tryLlm<T>(fn: (p: LlmProvider) => Promise<T>, log: (msg: string) => void, provider: LlmProvider | null = llm): Promise<T | null> {
  if (!provider) return null;
  try {
    return await fn(provider);
  } catch (e) {
    if (provider.userKey) {
      const err = provider.userKey.configError(e);
      if (err) throw err;
      log(`IA do usuário indisponível (${provider.name}/${provider.model}): ${provider.userKey.summary(e)}`);
      return null;
    }
    log(`IA indisponível (${provider.name}/${provider.model}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
