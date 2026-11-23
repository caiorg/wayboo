import Fastify from 'fastify';

// Cada arquivo de teste roda num worker novo. Lá, o primeiro `Fastify()` carrega o ajv e os compiladores de schema
// (mais de 100 módulos) e o primeiro `inject` carrega o light-my-request. Sem este aquecimento, esse custo cai no
// `beforeAll` que monta o app (prazo de 10 s) ou no primeiro teste (5 s) e, com a máquina carregada, estoura o prazo.
// O setup não tem prazo, e os módulos de node_modules continuam carregados depois de `vi.resetModules()`.
const warm = Fastify();
await warm.inject({ method: 'GET', url: '/' });
await warm.close();
