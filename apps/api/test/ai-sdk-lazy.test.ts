import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Registra cada módulo dos SDKs de IA importado; `importOriginal` devolve o módulo real.
const { loaded, track } = vi.hoisted(() => {
  const loaded = new Set<string>();
  const track = (id: string) => async (importOriginal: () => Promise<unknown>) => {
    loaded.add(id);
    return importOriginal();
  };
  return { loaded, track };
});
vi.mock('@anthropic-ai/sdk', track('@anthropic-ai/sdk'));
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', track('@anthropic-ai/sdk/helpers/beta/zod'));
vi.mock('openai', track('openai'));
vi.mock('openai/helpers/zod', track('openai/helpers/zod'));
vi.mock('openai/lib/parser', track('openai/lib/parser'));

// Na fase de import, sem prazo. `vitest.config.ts` define `AI_PROVIDER=none`.
import '../src/app';
import { openRouterProvider } from '../src/ai/providers';

describe('SDKs de IA sob demanda', () => {
  it('com AI_PROVIDER=none, importar o app não carrega nenhum SDK', () => {
    expect([...loaded]).toEqual([]);
  });

  // Prazo maior: o import do SDK cai dentro do teste, e com a máquina carregada passa de 1 s.
  it('o provedor só carrega o SDK na primeira chamada', { timeout: 30_000 }, async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/endpoints')
        ? Response.json({ data: { endpoints: [{ supported_parameters: ['structured_outputs'] }] } })
        : Response.json({
            id: 'gen-1',
            object: 'chat.completion',
            created: 0,
            model: 'm',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}', refusal: null } }],
          }),
    ) as unknown as typeof globalThis.fetch;
    const p = openRouterProvider({ model: 'm', apiKey: 'k', fetch });
    expect([...loaded]).toEqual([]);

    await expect(p.generateObject({ system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }), schemaName: 'x' })).resolves.toEqual({ ok: true });
    expect([...loaded].sort()).toEqual(['openai', 'openai/helpers/zod', 'openai/lib/parser']);
  });
});
