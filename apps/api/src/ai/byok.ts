import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { HttpError } from '../providers/http';
import { anthropicProvider, openAiCompatibleProvider, OPENROUTER_BASE_URL, openRouterProvider, type LlmProvider } from './providers';

/**
 * BYOK: o app manda a chave do usuário em cada requisição de IA (`x-ai-provider`, `x-ai-model`, `x-ai-key`).
 * O servidor só a repassa ao provedor: não grava em banco, não registra em log e não devolve em resposta nem em erro.
 */
export const BYOK_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ByokProviderName = (typeof BYOK_PROVIDERS)[number];

/** Chamadas com a chave do usuário por janela, por usuário e por IP (IPv6 por /64). */
export const BYOK_RATE = { perUser: 20, perIp: 60, windowMs: 60_000 };

export interface Byok {
  provider: ByokProviderName;
  model: string;
  apiKey: string;
}

/**
 * Endpoints oficiais fixos. A chave do usuário nunca vai para `AI_BASE_URL` nem para `ANTHROPIC_BASE_URL` ou
 * `OPENAI_BASE_URL` do servidor. Ollama fica de fora: precisaria de uma URL escolhida pelo cliente.
 */
const BASE_URL: Record<ByokProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: OPENROUTER_BASE_URL,
};

/** Nome com artigo, para as mensagens: "recusada pela OpenAI", "no OpenRouter". */
const NAMES: Record<ByokProviderName, { name: string; f: boolean }> = {
  anthropic: { name: 'Anthropic', f: true },
  openai: { name: 'OpenAI', f: true },
  openrouter: { name: 'OpenRouter', f: false },
};

/** ASCII visível, sem espaço: cabeçalho repetido chega unido por ", " e é recusado. */
const KEY = /^[\x21-\x7e]{20,512}$/;
/** Nome de modelo dos três provedores (`claude-opus-5-5`, `openai/gpt-4o-mini:free`). Sem `..`, `?` e `#`: o nome entra na URL do catálogo do OpenRouter. */
const MODEL = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const AI_HEADERS = ['x-ai-provider', 'x-ai-model', 'x-ai-key'] as const;

/** Cabeçalho repetido chega como lista ou unido por ", ": vira uma string com espaço, que as regex recusam. */
const headerText = (message: string, re: RegExp) =>
  z.preprocess((v) => (Array.isArray(v) ? v.join(', ') : v), z.string({ error: message }).trim().regex(re, { error: message }));

/** Mensagens fixas, sem `input`: o 400 nunca repete o valor recebido. A ordem das chaves define qual erro aparece. */
const ByokHeaders = z.object({
  'x-ai-provider': z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.enum(BYOK_PROVIDERS, { error: `x-ai-provider inválido (use ${BYOK_PROVIDERS.join(' | ')})` }),
  ),
  'x-ai-key': headerText('x-ai-key ausente ou em formato inválido', KEY),
  'x-ai-model': headerText('x-ai-model ausente ou inválido', MODEL),
});

/**
 * Lê a chave do usuário dos cabeçalhos. Sem nenhum dos três, `null`: a requisição usa o provedor do servidor.
 * Com só parte deles, ou com algum vazio, 400: quem mandou uma chave não pode cair calado na chave do servidor. As mensagens não ecoam valores.
 */
export function byokOf(headers: IncomingHttpHeaders): Byok | null {
  // Presença, não valor: cabeçalho vazio também é intenção de usar a chave própria e dá 400.
  if (AI_HEADERS.every((h) => headers[h] === undefined)) return null;
  const parsed = ByokHeaders.safeParse(headers);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]!.message);
  const { 'x-ai-provider': provider, 'x-ai-model': model, 'x-ai-key': apiKey } = parsed.data;
  return { provider, model, apiKey };
}

/** Nomes em `ANTHROPIC_CUSTOM_HEADERS` e `OPENAI_CUSTOM_HEADERS`: os SDKs os somam a todo cliente, mesmo com `apiKey`. */
function serverCustomHeaders(): string[] {
  return ['ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_CUSTOM_HEADERS'].flatMap((v) =>
    (process.env[v] ?? '').split('\n').flatMap((line) => (line.includes(':') ? [line.slice(0, line.indexOf(':')).trim()] : [])),
  );
}

/**
 * `fetch` dos clientes com a chave do usuário. Não segue redirecionamento, que levaria a chave a um destino não validado
 * (talvez `http://`). Tira os cabeçalhos que o servidor injeta pelo ambiente (um deles pode ser a credencial do servidor
 * ou de um gateway) e fixa a autenticação na chave do usuário.
 */
function userKeyFetch(apiKey: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of serverCustomHeaders()) if (name) headers.delete(name);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${apiKey}`);
    return globalThis.fetch(input, { ...init, headers, redirect: 'error' });
  };
}

const statusOf = (e: unknown) => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** Erro de configuração do usuário (chave, crédito, modelo) em texto nosso; o texto do provedor fica de fora. */
function configError(e: unknown, { provider, model }: Byok): Error | null {
  const { name, f } = NAMES[provider];
  const status = statusOf(e);
  const { code, type } = (e ?? {}) as { code?: unknown; type?: unknown };
  const quota = status === 402 || (status === 429 && (code === 'insufficient_quota' || type === 'insufficient_quota'));
  if (status === 401) return new HttpError(422, `A chave de IA foi recusada ${f ? 'pela' : 'pelo'} ${name}. Confira a chave em Ajustes.`);
  if (status === 403)
    return new HttpError(422, `A chave de IA não tem permissão para usar ${model} ${f ? 'na' : 'no'} ${name}. Confira o modelo em Ajustes.`);
  if (quota) return new HttpError(422, `A conta ${f ? 'da' : 'do'} ${name} está sem crédito para esta chave. Confira em Ajustes.`);
  if (status === 404) return new HttpError(422, `${f ? 'A' : 'O'} ${name} não encontrou o modelo ${model}. Confira o nome em Ajustes.`);
  return null;
}

/** Só a classe do erro e o status HTTP: a OpenAI ecoa parte da chave na mensagem do 401, e a Anthropic manda o corpo inteiro. */
function summary(e: unknown): string {
  const status = statusOf(e);
  const kind = e instanceof Error ? e.name : typeof e;
  return status === undefined ? kind : `${kind} HTTP ${status}`;
}

/** Provedor criado por requisição com a chave do usuário. */
export function byokProvider(b: Byok): LlmProvider {
  const { provider, model, apiKey } = b;
  const fetch = userKeyFetch(apiKey);
  // `logLevel: 'off'`: com ANTHROPIC_LOG ou OPENAI_LOG em `debug`, o SDK imprime no console o corpo do erro, que pode ecoar a chave.
  const base =
    provider === 'anthropic'
      ? anthropicProvider(model, { apiKey, baseURL: BASE_URL.anthropic, fetch, logLevel: 'off' })
      : provider === 'openai'
        ? openAiCompatibleProvider({ name: 'openai', model, apiKey, baseURL: BASE_URL.openai, fetch, ignoreEnv: true, logLevel: 'off' })
        : openRouterProvider({ model, apiKey, baseURL: BASE_URL.openrouter, fetch, logLevel: 'off' });
  return { ...base, userKey: { configError: (e) => configError(e, b), summary } };
}
