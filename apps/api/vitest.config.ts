import { defineConfig } from 'vitest/config';

// `config.ts` e `db.ts` leem o ambiente ao serem importados: cada arquivo de teste começa com um banco vazio em memória.
// Sem consulta ao Photon nos testes; `holidays.test.ts` liga em `config`.
export default defineConfig({
  test: { env: { DB_PATH: ':memory:', AI_PROVIDER: 'none', REGIONAL_HOLIDAYS: 'off' }, setupFiles: ['./test/setup.ts'] },
});
