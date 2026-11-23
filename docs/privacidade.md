# O que o servidor guarda e por quanto tempo

Este documento lista os dados que a API do Wayboo (`apps/api`) grava no SQLite (`DB_PATH`), o motivo e o prazo. O schema está em `apps/api/src/db.ts`.

## Identificação

O app gera um token aleatório de 256 bits e o registra em `POST /auth/device`. O servidor guarda só o hash SHA-256 do token (`devices`), ligado a um `user_id` aleatório. Não há nome, e-mail ou telefone.

## Dados por usuário

| Tabela | O que tem | Para quê | Prazo |
| --- | --- | --- | --- |
| `samples` | Rastro GPS bruto: horário, latitude, longitude, velocidade, rumo e precisão de cada ponto | Medir quanto cada trecho demorou ao encerrar a viagem | Apagado `GPS_RETENTION_HOURS` horas depois do fim da viagem (padrão 24). Viagem nunca encerrada conta como abandonada 24 horas (ou o prazo, se maior) depois do último envio de amostras, pelo relógio do servidor. Sem nenhum envio, o prazo conta do início da viagem |
| `plans` | Pedido de rota: origem, destino, rotas sugeridas com geometria e contexto | Iniciar a viagem e gerar o resumo do copiloto | Sem viagem: `GPS_RETENTION_HOURS` horas depois de criado, na rodada de limpeza; cada plano novo também apaga os sem viagem com mais de 2 dias. Com viagem: o mesmo prazo do rastro GPS |
| `trips`, `trip_legs` | Resumo da viagem: início, fim, duração prevista e real, distância, lugares de origem e destino, erro da previsão | Histórico, estatísticas em `GET /insights` e tempo médio de rotinas | Até o usuário apagar |
| `stats` | Tempo aprendido por trecho de rua, contexto e par origem-destino (média com decaimento) | Prever o tempo das próximas viagens | Até o usuário apagar |
| `anomalies` | Trecho, momento, tempo esperado e observado quando a diferença foi grande | Registro; hoje só a contagem aparece no fim da viagem | Até o usuário apagar |
| `places` | Lugares frequentes (coordenada, nome dado pelo usuário, se é casa ou trabalho, contagem de visitas) | Sugerir destinos e reconhecer rotinas | Até o usuário apagar |
| `routines` | Histograma de horários de saída por origem, destino e tipo de dia | Sugestões de saída | Até o usuário apagar |
| `routine_routes` | Rotas sugeridas para cada rotina, com os pontos de origem e destino pedidos | Reaproveitar a rota habitual em `/suggestions` sem chamar o roteador | Vence em `SUGGESTION_ROUTE_MAX_AGE_MIN` (padrão 24 horas) e sai na rodada de limpeza seguinte (a cada hora) ou antes, na próxima consulta de sugestões de qualquer usuário |
| `prefs` | Pesos aprendidos das escolhas de rota (tempo, distância, pedágio, rodovia, curvas, familiaridade) | Ordenar as rotas sugeridas | Até o usuário apagar |
| `privacy` | Opt-in do aprendizado coletivo | Decidir se a viagem soma ao agregado | Até o usuário apagar |
| `alerts` | Alertas que o usuário criou (tipo, coordenada, horário) | Mostrar o alerta para a comunidade | Some do mapa ao expirar (30 min a 180 dias, conforme o tipo); a linha e os votos saem `GPS_RETENTION_HOURS` horas depois |
| `alert_votes` | Voto do usuário em alertas de outros | Impedir voto repetido | Até o usuário apagar |

## Dados agregados

Com o opt-in de `PUT /privacy` ligado, a viagem soma ao usuário agregado (`user_id = '*'` em `stats`) só a duração relativa de cada trecho, com o tipo de dia e a faixa de 30 minutos. A data vai sem horário. Não vai rastro, lugar nem `user_id`, então essa contribuição não pode ser separada depois e continua no agregado mesmo após o usuário apagar os dados.

## Direitos do titular (LGPD, art. 18)

- `GET /me/export` devolve em JSON todas as linhas das tabelas acima ligadas ao usuário autenticado, menos o hash do token.
- `DELETE /me` apaga todas essas linhas, inclusive o registro do aparelho, e o token deixa de valer. Alertas criados pelo usuário continuam visíveis para a comunidade até expirar, mas sem autor (`reporter = '*'`). A contagem de votos dos alertas de outras pessoas não muda. O `user_id` apagado fica em `deleted_users`, só o id e sem data, para que `POST /auth/device` não o adote de novo como `legacyUserId`. Assim, um aparelho restaurado de backup recebe outro id.
- No app, Ajustes > Privacidade tem os botões para exportar e para apagar os dados. A exportação baixa o JSON na web e, no Android e no iOS, abre a folha de compartilhamento do sistema.

## Configuração

`GPS_RETENTION_HOURS` define o prazo do rastro GPS, dos planos e dos alertas expirados (padrão `24`, que também vale para valor vazio; `0` apaga na próxima rodada). Valor não numérico ou negativo impede o servidor de subir. A rotina roda ao subir o servidor e a cada hora (`apps/api/src/server.ts`) e também apaga as rotas de `routine_routes` vencidas.
