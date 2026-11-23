import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { db, setShareCrowd } from '../src/db';

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
