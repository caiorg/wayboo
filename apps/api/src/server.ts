import { buildApp } from './app';
import { llm } from './ai/providers';
import { config } from './config';
import { purgeExpiredTraces } from './db';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
app.log.info(`IA: ${llm ? `${llm.name} / ${llm.model}` : 'desativada (modo regras)'}`);

/** Retenção dos rastros GPS: roda ao subir e a cada hora. */
const RETENTION_SWEEP_MS = 3_600_000;
function sweepTraces() {
  try {
    const r = purgeExpiredTraces(config.gpsRetentionHours * 3_600_000);
    if (r.samples || r.plans || r.alerts || r.routineRoutes || r.liveObservations) {
      app.log.info(
        `Retenção: ${r.samples} pontos GPS, ${r.plans} planos, ${r.alerts} alertas, ${r.routineRoutes} rotas de rotina e ${r.liveObservations} medidas ao vivo apagados`,
      );
    }
  } catch (e) {
    app.log.error(e, 'Falha na rotina de retenção dos rastros GPS');
  }
}
sweepTraces();
setInterval(sweepTraces, RETENTION_SWEEP_MS).unref();
