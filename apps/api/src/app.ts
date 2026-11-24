import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import {
  AlertCreateSchema,
  AssistantRequestSchema,
  LatLonSchema,
  PlacePatchSchema,
  PlanRequestSchema,
  PrivacySchema,
  RerouteSchema,
  SamplesSchema,
  StartTripSchema,
  tradeoffs,
  VoteSchema,
} from '@wayboo/core';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { BYOK_PROVIDERS, BYOK_RATE, byokOf, byokProvider } from './ai/byok';
import { briefPlan, narrateInsights } from './ai/planner';
import { llm } from './ai/providers';
import { config } from './config';
import {
  alertsInBox,
  db,
  deleteUserData,
  deviceOfToken,
  exportUserData,
  getPlaces,
  getPlan,
  getPrefs,
  getShareCrowd,
  listDevices,
  registerDevice,
  revokeDevice,
  setShareCrowd,
  toAlert,
  upsertPlace,
} from './db';
import { geocode, reverseGeocode } from './providers/geo-services';
import { HttpError } from './providers/http';
import { fixedWindowLimiter, ipKey } from './rate-limit';
import { assistant, insights, suggestions } from './services/assistant';
import { plan } from './services/planning';
import { addSamples, finishTrip, rerouteTrip, startTrip } from './services/trips';

/** Token gerado pelo aparelho e registrado em `POST /auth/device`: 32 bytes em base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

function authOf(req: FastifyRequest): { userId: string; deviceId: string } {
  const m = BEARER.exec(req.headers.authorization ?? '');
  const device = m ? deviceOfToken(m[1]!) : null;
  if (!device) throw new HttpError(401, 'Token de autenticação ausente ou inválido');
  return device;
}

const userOf = (req: FastifyRequest) => authOf(req).userId;

function revokeOrThrow(userId: string, deviceId: string): void {
  const result = revokeDevice(userId, deviceId);
  if (result === 'not_found') throw new HttpError(404, 'Aparelho não encontrado');
  if (result === 'last') throw new HttpError(409, 'Este é o único aparelho conectado. Para sair dele, apague seus dados.');
}

const tzOf = (req: FastifyRequest) => z.string().min(1).max(64).catch('America/Sao_Paulo').parse(req.headers['x-time-zone']);
const log = (req: FastifyRequest) => (msg: string) => req.log.warn(msg);


const ALERT_TTL_MIN: Record<string, number> = {
  accident: 45,
  traffic: 30,
  hazard: 60,
  pothole: 60 * 24 * 14,
  police: 60,
  speed_camera: 60 * 24 * 180,
  road_closed: 60 * 6,
  flood: 60 * 3,
};

function vote(userId: string, alertId: string, up: boolean) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as Record<string, string | number | null> | undefined;
  if (!a) throw new HttpError(404, 'Alerta não encontrado');
  const prev = db.prepare('SELECT up FROM alert_votes WHERE alert_id = ? AND user_id = ?').get(alertId, userId) as { up: number } | undefined;
  if (!prev && a.reporter !== userId) {
    db.prepare('INSERT INTO alert_votes (alert_id, user_id, up) VALUES (?, ?, ?)').run(alertId, userId, up ? 1 : 0);
    const ttl = ALERT_TTL_MIN[String(a.type)]! * 60_000;
    // Confirmação renova a validade; "não está mais lá" encurta. Três negativos a mais que positivos removem.
    if (up) db.prepare('UPDATE alerts SET up = up + 1, expires_at = MAX(expires_at, ?) WHERE id = ?').run(Date.now() + ttl, alertId);
    else
      db.prepare('UPDATE alerts SET down = down + 1, expires_at = CASE WHEN down + 1 - up >= 3 THEN ? ELSE expires_at - ? END WHERE id = ?').run(
        Date.now(),
        Math.round(ttl / 3),
        alertId,
      );
  }
  return toAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as Record<string, string | number | null>);
}

/** Monta a API sem abrir porta, para o servidor e para os testes (`app.inject`). */
export async function buildApp(opts: { logger?: boolean; logStream?: Writable } = {}) {
  const app = Fastify({
    // O serializador padrão não registra cabeçalhos; o `redact` cobre um serializador ou log futuro que os inclua.
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: ['req.headers.authorization', 'req.headers["x-ai-key"]'],
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });
  // O padrão do plugin só libera GET, HEAD e POST; o app web também usa PUT, PATCH e DELETE.
  // `Retry-After` não é cabeçalho liberado pelo CORS: sem expor, o app web não lê a espera do 429.
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: ['Retry-After'],
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Requisição inválida', issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Erro interno' });
  });

  // CWE-525: quase toda rota devolve dado do usuário ou recebe a posição dele na URL, e nenhuma tem cache útil.
  // Por isso nada fica guardado no cliente, a menos que a rota defina o próprio `cache-control`.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // Cada pedido com chave do usuário chama o provedor com a chave recebida. Sem limite, a API vira um verificador de
  // chaves alheias: o 422 diz se a chave vale, tem crédito e acessa o modelo. Tokens de aparelho são baratos, por isso
  // também por IP.
  const byokPerUser = fixedWindowLimiter(BYOK_RATE.perUser, BYOK_RATE.windowMs);
  const byokPerIp = fixedWindowLimiter(BYOK_RATE.perIp, BYOK_RATE.windowMs);
  /** Provedor com a chave do usuário (`x-ai-*`); sem os cabeçalhos, `undefined` e vale o do servidor. */
  const aiOf = (req: FastifyRequest, userId: string) => {
    const byok = byokOf(req.headers);
    if (!byok) return undefined;
    const waitS = byokPerUser(userId) ?? byokPerIp(ipKey(req.ip));
    if (waitS) throw new HttpError(429, `Muitas chamadas com a chave de IA própria. Tente de novo em ${waitS} s.`);
    return byokProvider(byok);
  };

  app.get('/health', async () => ({
    ok: true,
    ai: llm ? { provider: llm.name, model: llm.model } : null,
    byok: BYOK_PROVIDERS,
    map: config.mapStyles,
  }));

  // Cada registro cria uma linha em `devices`: sem limite, um cliente enche a tabela.
  const { max, windowMs } = config.authDeviceRateLimit;
  const deviceLimit = max > 0 ? fixedWindowLimiter(max, windowMs) : null;
  const limitDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const retryAfterS = deviceLimit?.(ipKey(req.ip));
    if (!retryAfterS) return;
    return reply.status(429).header('retry-after', String(retryAfterS)).send({ error: 'Muitos registros deste endereço; tente mais tarde' });
  };

  app.post('/auth/device', { onRequest: limitDevice }, async (req) => {
    const b = z.object({ token: z.string().regex(TOKEN), legacyUserId: z.string().uuid().optional() }).parse(req.body ?? {});
    const device = registerDevice(b.token, b.legacyUserId);
    if (!device) throw new HttpError(401, 'Token revogado');
    return device;
  });

  // Sair: revoga o token de quem chama.
  app.post('/auth/logout', async (req, reply) => {
    const { userId, deviceId } = authOf(req);
    revokeOrThrow(userId, deviceId);
    return reply.status(204).send();
  });

  app.get('/devices', async (req) => {
    const { userId, deviceId } = authOf(req);
    return { devices: listDevices(userId).map((d) => ({ ...d, current: d.id === deviceId })) };
  });

  app.delete('/devices/:id', async (req, reply) => {
    const userId = userOf(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    revokeOrThrow(userId, id);
    return reply.status(204).send();
  });

  app.get('/geocode', async (req) => {
    const q = z.object({ q: z.string().min(2).max(200), lat: z.coerce.number().optional(), lon: z.coerce.number().optional() }).parse(req.query);
    const near = q.lat !== undefined && q.lon !== undefined ? { lat: q.lat, lon: q.lon } : undefined;
    return { results: await geocode(q.q, near) };
  });

  app.get('/reverse', async (req) => {
    const q = LatLonSchema.extend({ lat: z.coerce.number(), lon: z.coerce.number() }).parse(req.query);
    return { result: await reverseGeocode(q.lat, q.lon) };
  });

  app.post('/plan', async (req) => plan(userOf(req), PlanRequestSchema.parse(req.body)));

  app.post('/plan/:id/brief', async (req) => {
    const userId = userOf(req);
    const ai = aiOf(req, userId);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = getPlan(userId, id);
    if (!p) throw new HttpError(404, 'Plano não encontrado');
    const prefs = getPrefs(userId);
    const labels = prefs.updates > 0 ? tradeoffs(prefs.weights).map((t) => t.label) : [];
    return briefPlan(p, tzOf(req), labels, log(req), ai);
  });

  app.post('/assistant', async (req) => {
    const userId = userOf(req);
    const ai = aiOf(req, userId);
    const body = AssistantRequestSchema.parse(req.body);
    return assistant(userId, body.text, body.origin, body.timeZone, log(req), ai);
  });

  app.get('/suggestions', async (req) => {
    const q = z.object({ lat: z.coerce.number(), lon: z.coerce.number() }).parse(req.query);
    return { suggestions: await suggestions(userOf(req), q, tzOf(req)) };
  });

  app.post('/trips', async (req) => {
    const b = StartTripSchema.parse(req.body);
    return startTrip(userOf(req), b.planId, b.routeIndex, b.timeZone);
  });

  app.post('/trips/:id/samples', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return addSamples(userOf(req), id, SamplesSchema.parse(req.body).samples);
  });

  app.post('/trips/:id/reroute', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = RerouteSchema.parse(req.body);
    return rerouteTrip(userOf(req), id, b.planId, b.routeIndex);
  });

  app.post('/trips/:id/finish', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return finishTrip(userOf(req), id);
  });

  // ---------- privacidade ----------

  app.get('/privacy', async (req) => ({ shareCrowd: getShareCrowd(userOf(req)) }));

  app.put('/privacy', async (req) => {
    const userId = userOf(req);
    setShareCrowd(userId, PrivacySchema.parse(req.body).shareCrowd);
    return { shareCrowd: getShareCrowd(userId) };
  });

  // Portabilidade e eliminação (LGPD art. 18). O que é guardado está em docs/privacidade.md.
  app.get('/me/export', async (req, reply) => {
    const data = exportUserData(userOf(req));
    return reply.header('content-disposition', 'attachment; filename="wayboo-dados.json"').send(data);
  });

  app.delete('/me', async (req) => ({ deleted: deleteUserData(userOf(req)) }));

  // ---------- alertas da comunidade ----------

  app.get('/alerts', async (req) => {
    const q = z
      .object({ minLat: z.coerce.number(), minLon: z.coerce.number(), maxLat: z.coerce.number(), maxLon: z.coerce.number() })
      .parse(req.query);
    return { alerts: alertsInBox(q.minLat, q.minLon, q.maxLat, q.maxLon) };
  });

  app.post('/alerts', async (req) => {
    const userId = userOf(req);
    const b = AlertCreateSchema.parse(req.body);
    // Mesmo tipo a menos de ~80 m vira confirmação do alerta existente, não duplicata.
    const near = db
      .prepare('SELECT * FROM alerts WHERE type = ? AND expires_at > ? AND ABS(lat - ?) < 0.0008 AND ABS(lon - ?) < 0.0008 LIMIT 1')
      .get(b.type, Date.now(), b.lat, b.lon) as Record<string, string | number | null> | undefined;
    if (near) return vote(userId, String(near.id), true);
    const now = Date.now();
    const id = randomUUID();
    db.prepare('INSERT INTO alerts (id, type, lat, lon, note, created_at, expires_at, reporter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      b.type,
      b.lat,
      b.lon,
      b.note ?? null,
      now,
      now + ALERT_TTL_MIN[b.type]! * 60_000,
      userId,
    );
    return toAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Record<string, string | number | null>);
  });

  app.post('/alerts/:id/vote', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return vote(userOf(req), id, VoteSchema.parse(req.body).up);
  });

  // ---------- aprendizado ----------

  app.get('/insights', async (req) => insights(userOf(req)));

  app.post('/insights/narrative', async (req) => {
    const userId = userOf(req);
    const ai = aiOf(req, userId);
    return (await narrateInsights(insights(userId), log(req), ai)) ?? { text: null, provider: 'nenhum' };
  });

  app.patch('/places/:id', async (req) => {
    const userId = userOf(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = PlacePatchSchema.parse(req.body);
    const places = getPlaces(userId);
    const p = places.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'Lugar não encontrado');
    // Só pode haver uma casa e um trabalho fixados.
    if (b.kind === 'home' || b.kind === 'work') {
      for (const other of places) if (other.id !== id && other.kind === b.kind) upsertPlace(userId, { ...other, kind: 'other', pinned: false });
    }
    const next = { ...p, kind: b.kind ?? p.kind, name: b.name === undefined ? p.name : b.name, pinned: true };
    upsertPlace(userId, next);
    return next;
  });

  return app;
}
