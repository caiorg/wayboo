import { defineConfig } from 'vitest/config';

// `config.ts` e `db.ts` leem o ambiente ao serem importados: cada arquivo de teste começa com um banco vazio em memória.
export default defineConfig({
  test: { env: { DB_PATH: ':memory:', AI_PROVIDER: 'none' }, setupFiles: ['./test/setup.ts'] },
});
