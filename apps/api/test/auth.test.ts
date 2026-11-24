import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { db, migrateDevices, setShareCrowd } from '../src/db';

type Device = { userId: string; token: string };

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const newToken = () => randomBytes(32).toString('base64url');

async function register(legacyUserId?: string, token = newToken()): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/auth/device', payload: legacyUserId ? { token, legacyUserId } : { token } });
  expect(res.statusCode).toBe(200);
  return { ...res.json<{ userId: string }>(), token };
}

const privacy = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/privacy', headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('autenticação por aparelho', () => {
  it('recusa requisição sem token, com token inventado ou só com x-user-id', async () => {
    const { userId } = await register();
    expect((await privacy({})).statusCode).toBe(401);
    expect((await privacy(bearer('A'.repeat(43)))).statusCode).toBe(401);
    expect((await privacy(bearer('curto'))).statusCode).toBe(401);
    expect((await privacy({ 'x-user-id': userId })).statusCode).toBe(401);
  });

  it('token registrado dá acesso só aos dados do próprio usuário', async () => {
    const a = await register();
    const b = await register();
    expect(a.userId).not.toBe(b.userId);

    const put = await app.inject({ method: 'PUT', url: '/privacy', headers: bearer(a.token), payload: { shareCrowd: true } });
    expect(put.json()).toEqual({ shareCrowd: true });
    expect((await privacy(bearer(b.token))).json()).toEqual({ shareCrowd: false });
  });

  it('guarda só o hash do token', async () => {
    const { token } = await register();
    const all = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(all).not.toContain(token);
  });

  it('adota o UUID anônimo antigo uma única vez', async () => {
    const legacy = randomUUID();
    setShareCrowd(legacy, true);

    const first = await register(legacy);
    expect(first.userId).toBe(legacy);
    expect((await privacy(bearer(first.token))).json()).toEqual({ shareCrowd: true });

    const second = await register(legacy);
    expect(second.userId).not.toBe(legacy);
    expect((await privacy(bearer(second.token))).json()).toEqual({ shareCrowd: false });
  });

  it('não adota de novo o UUID de um usuário apagado', async () => {
    // Aparelho restaurado de backup sem o token, ou registro em curso durante o `DELETE /me`.
    const legacy = randomUUID();
    const first = await register(legacy);
    expect(first.userId).toBe(legacy);
    expect((await app.inject({ method: 'DELETE', url: '/me', headers: bearer(first.token) })).statusCode).toBe(200);

    const again = await register(legacy);
    expect(again.userId).not.toBe(legacy);
    const retryOld = await register(legacy, first.token);
    expect(retryOld.userId).not.toBe(legacy);
  });

  it('repetir o registro com o mesmo token devolve o mesmo usuário', async () => {
    // Resposta perdida: o aparelho reenvia o token que já tinha gravado.
    const legacy = randomUUID();
    const first = await register(legacy);
    const retry = await register(legacy, first.token);
    expect(retry.userId).toBe(legacy);
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(legacy)).toEqual({ n: 1 });
  });

  it('valida o token e o UUID antigo', async () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/auth/device', payload });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ token: 'curto' })).statusCode).toBe(400);
    expect((await post({ token: newToken(), legacyUserId: 'nao-uuid' })).statusCode).toBe(400);
  });
});

type DeviceInfo = { id: string; createdAt: string; lastSeenAt: string | null; current: boolean };

/** A API ainda não vincula um segundo aparelho ao mesmo usuário; o teste grava a linha direto. */
function addDevice(userId: string): Device {
  const token = newToken();
  const hash = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO devices (id, token_hash, user_id, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), hash, userId, Date.now());
  return { userId, token };
}

const devices = async (d: Device) => {
  const res = await app.inject({ method: 'GET', url: '/devices', headers: bearer(d.token) });
  expect(res.statusCode).toBe(200);
  return res.json<{ devices: DeviceInfo[] }>().devices;
};
const revoke = (d: Device, id: string) => app.inject({ method: 'DELETE', url: `/devices/${id}`, headers: bearer(d.token) });
const logout = (d: Device) => app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(d.token) });
const idOf = async (d: Device) => (await devices(d)).find((x) => x.current)!.id;

describe('aparelhos do usuário', () => {
  it('lista só os aparelhos ativos do próprio usuário e marca o atual, sem o hash do token', async () => {
    const a = await register();
    const a2 = addDevice(a.userId);
    await register();

    const list = await devices(a);
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    for (const d of list) {
      expect(Object.keys(d).sort()).toEqual(['createdAt', 'current', 'id', 'lastSeenAt']);
      expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await devices(a2)).find((d) => d.current)!.id).not.toBe(await idOf(a));
  });

  it('revoga outro aparelho: o token dele recebe 401 e sai da lista', async () => {
    const a = await register();
    const a2 = addDevice(a.userId);
    const target = await idOf(a2);

    expect((await revoke(a, target)).statusCode).toBe(204);
    expect((await privacy(bearer(a2.token))).statusCode).toBe(401);
    expect((await privacy(bearer(a.token))).statusCode).toBe(200);
    expect((await devices(a)).map((d) => d.id)).not.toContain(target);
    expect((await revoke(a, target)).statusCode).toBe(404);
  });

  it('token revogado não volta pelo registro, e o id do usuário continua reivindicado', async () => {
    const a = await register();
    const a2 = addDevice(a.userId);
    await revoke(a, await idOf(a2));

    const again = await app.inject({ method: 'POST', url: '/auth/device', payload: { token: a2.token, legacyUserId: a.userId } });
    expect(again.statusCode).toBe(401);
    expect((await privacy(bearer(a2.token))).statusCode).toBe(401);
    // Sair do último aparelho é recusado, então o id só fica sem aparelho ativo se houver outra via; mesmo assim não é adotado.
    db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ?').run(Date.now(), a.userId);
    expect((await register(a.userId)).userId).not.toBe(a.userId);
  });

  it('recusa revogar o último aparelho ativo, por revogação ou por saída', async () => {
    const a = await register();
    expect((await revoke(a, await idOf(a))).statusCode).toBe(409);
    expect((await logout(a)).statusCode).toBe(409);
    expect((await privacy(bearer(a.token))).statusCode).toBe(200);
  });

  it('sair revoga só o token de quem chamou', async () => {
    const a = await register();
    const a2 = addDevice(a.userId);

    expect((await logout(a2)).statusCode).toBe(204);
    expect((await privacy(bearer(a2.token))).statusCode).toBe(401);
    expect((await devices(a)).map((d) => d.current)).toEqual([true]);
  });

  it('não revoga aparelho de outro usuário', async () => {
    const a = await register();
    addDevice(a.userId);
    const b = await register();
    addDevice(b.userId);

    expect((await revoke(a, await idOf(b))).statusCode).toBe(404);
    expect((await privacy(bearer(b.token))).statusCode).toBe(200);
    expect((await revoke(a, randomUUID())).statusCode).toBe(404);
    expect((await revoke(a, 'nao-uuid')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/devices' })).statusCode).toBe(401);
  });

  it('grava o último uso no máximo uma vez por hora', async () => {
    const a = await register();
    const lastSeen = () => Number((db.prepare('SELECT last_seen_at AS t FROM devices WHERE user_id = ?').get(a.userId) as { t: number }).t);
    const old = Date.now() - 2 * 3_600_000;
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE user_id = ?').run(old, a.userId);
    await privacy(bearer(a.token));
    expect(lastSeen()).toBeGreaterThan(Date.now() - 60_000);

    const recent = Date.now() - 10 * 60_000;
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE user_id = ?').run(recent, a.userId);
    await privacy(bearer(a.token));
    expect(lastSeen()).toBe(recent);
    expect((await devices(a))[0]!.lastSeenAt).toBe(new Date(recent).toISOString());
  });

  it('migra a tabela antiga: aparelhos existentes ganham id e continuam ativos', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE devices (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.prepare('INSERT INTO devices VALUES (?, ?, ?), (?, ?, ?)').run('h1', 'u', 1, 'h2', 'u', 2);
    migrateDevices(old);
    migrateDevices(old);
    const rows = old.prepare('SELECT id, revoked_at, last_seen_at FROM devices ORDER BY created_at').all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), revoked_at: null, last_seen_at: null },
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), revoked_at: null, last_seen_at: null },
    ]);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });
});
