# Self-host

O `docker-compose.yml` da raiz sobe o Wayboo inteiro numa máquina sua: API, roteamento, busca e mapa. Depois do preparo inicial, nada sai para serviço externo, exceto o clima (Open-Meteo), que é opcional.

| Serviço | Imagem | Função |
| --- | --- | --- |
| `api` | `apps/api/Dockerfile` | API do Wayboo (SQLite no volume `api`) |
| `valhalla` | `ghcr.io/valhalla/valhalla-scripted` | Rotas, a partir do extrato OSM |
| `photon` | `rtuszik/photon-docker` | Busca de endereços e POIs, com índice pronto por região |
| `tiles` | `protomaps/go-pmtiles` | Tiles vetoriais do arquivo PMTiles |
| `gateway` | `caddy` | Porta única para o app |
| `osm-extract` | `alpine` | Preparo: baixa o extrato `.osm.pbf` |
| `tiles-build` | `ghcr.io/onthegomap/planetiler` | Preparo: gera o PMTiles a partir do extrato |
| `map-assets` | mesma imagem da API | Preparo: baixa estilos, fontes e sprites do OpenFreeMap e reescreve os estilos com `PUBLIC_URL` |

Os serviços de preparo rodam até terminar e só refazem o trabalho quando algo muda. Trocar `OSM_EXTRACT_URL` baixa o novo extrato e refaz o grafo do Valhalla e os tiles (ver [Atualizar os dados](#atualizar-os-dados)). Trocar `PUBLIC_URL` regrava os estilos.

O gateway expõe tudo numa porta (padrão `8080`):

| Caminho | Destino |
| --- | --- |
| `/tiles/region/{z}/{x}/{y}.mvt` | `tiles` |
| `/map/styles/light.json`, `/map/styles/dark.json` | estilos do mapa |
| `/map/fonts/...`, `/map/sprites/...` | fontes e ícones do mapa |
| qualquer outro | `api` |

## Requisitos

Os números abaixo dependem do tamanho do extrato. Referências: o extrato do Brasil na Geofabrik tem cerca de 2,1 GB e o da América do Sul, 4,2 GB (novembro de 2026).

| Parte | Disco | Memória |
| --- | --- | --- |
| Extrato OSM | o tamanho do `.pbf` | não se aplica |
| Planetiler (só no preparo) | 1 GB + 5 a 10 vezes o `.pbf`, mais cerca de 1,3 GB de dados auxiliares (água, lagos e Natural Earth) baixados uma vez | metade do tamanho do `.pbf`, no mínimo (`PLANETILER_MEMORY`) |
| PMTiles gerado | menor que o `.pbf` | o `go-pmtiles` usa um cache de 64 MB |
| Valhalla | grafo, tabelas de fuso e de limites administrativos | o build do grafo é a fase mais pesada; reduza `VALHALLA_THREADS` se o processo for encerrado por falta de memória |
| Photon | índice da região: `south-america` tem cerca de 14 GB compactado, e o índice extraído é maior | ajuste `PHOTON_MEMORY` ao tamanho do índice |
| Fontes e sprites | cerca de 100 MB | não se aplica |

Os números do Planetiler vêm do README do projeto, e os do Photon, do README do `photon-docker`. O `photon-docker` confere o espaço livre antes de baixar o índice. Para o Valhalla não há número oficial: meça com o seu extrato.

Medido: API, Valhalla, Photon e gateway com Andorra rodam numa máquina com 8 GB de RAM. Estimativa, sem medição: para o Brasil, planeje SSD e pelo menos 16 GB de RAM, por causa do índice `south-america` do Photon e do build do Valhalla.

Precisa também de Docker com o Compose v2 (no Linux, Docker Engine 20.10 ou mais novo) e de acesso à internet durante o preparo.

## Instalação

1. Copie a configuração e ajuste:

   ```sh
   cp .env.example .env
   ```

   - `PUBLIC_URL`: a URL com que o celular chega ao gateway, por exemplo `http://192.168.0.10:8080`. Ela vai dentro dos estilos do mapa, então `localhost` só funciona no navegador da própria máquina.
   - `OSM_EXTRACT_URL`: o `.osm.pbf` da região. A Geofabrik tem extratos por país e por região do Brasil, por exemplo `https://download.geofabrik.de/south-america/brazil/sudeste-latest.osm.pbf`.
   - `PHOTON_REGION`: a região do índice de busca. O `photon-docker` só tem índice pronto para algumas regiões; o Brasil está dentro de `south-america`. A lista fica no README do [`photon-docker`](https://github.com/rtuszik/photon-docker#available-regions).

2. Suba a stack:

   ```sh
   docker compose up -d --build
   ```

   A primeira subida baixa o extrato, gera os tiles, constrói o grafo do Valhalla e baixa o índice do Photon. Com um extrato estadual isso leva de minutos a horas. Acompanhe com:

   ```sh
   docker compose logs -f tiles-build valhalla photon
   ```

3. Confira:

   ```sh
   curl http://localhost:8080/health
   ```

   A resposta traz `map` com as URLs dos estilos. Busca e rotas ficam disponíveis quando `photon` e `valhalla` aparecem como `healthy` em `docker compose ps`.

4. No app, abra Ajustes, troque a URL do servidor pela `PUBLIC_URL` e toque em testar. O status mostra "Mapa do próprio servidor". O app lê os estilos em `/health` e os guarda, então o mapa já abre pelo servidor próprio no próximo início.

## Variáveis da API

O serviço `api` lê o `.env` (`env_file`). Todas as variáveis da API são opcionais e estão comentadas no bloco "Variáveis da API" do `.env.example`, com o padrão de cada uma. Para mudar uma, descomente a linha no `.env` e rode `docker compose up -d api`.

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `GPS_RETENTION_HOURS` | `24` | Horas que o servidor guarda o rastro GPS, os planos e os alertas expirados. Com `0`, a próxima rodada de limpeza, que roda ao subir a API e a cada hora, apaga o rastro das viagens encerradas. O rastro de uma viagem ativa fica enquanto ela enviar amostras e só sai depois de mais de 24 horas sem envio. Valor não numérico ou negativo impede a API de subir. O que cada tabela guarda está em [`docs/privacidade.md`](privacidade.md). |
| `LIVE_TRAFFIC_MIN_USERS` | `3` | Mínimo de usuários distintos com opt-in que passaram por um trecho nos últimos 15 minutos para o trânsito ao vivo desse trecho entrar no ETA. Inteiro a partir de `2`; outro valor impede a API de subir. |
| `AI_PROVIDER` | detectado pela chave | `anthropic`, `openai`, `ollama`, `openrouter` ou `none`. Sem valor, a API usa o provedor da chave presente (`ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, nessa ordem) e, sem chave, desliga a IA. |
| `AI_MODEL` | `claude-opus-5-5` com `anthropic` | Obrigatório com `openai`, `ollama` e `openrouter`. |
| `AI_BASE_URL` | `http://localhost:11434/v1` com `ollama`, `https://openrouter.ai/api/v1` com `openrouter` | Dentro do contêiner, `localhost` é o próprio contêiner. Para um Ollama na máquina, use `http://host.docker.internal:11434/v1` (ver [Ollama na mesma máquina](#ollama-na-mesma-máquina)). |
| `AI_TIMEOUT_MS` | `15000` | Tempo máximo de cada chamada ao modelo. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY` | sem padrão (`OLLAMA_API_KEY`: `ollama`) | Chave do provedor. Uma chave remota faz a API chamar serviço externo (ver [O que ainda chama serviço externo](#o-que-ainda-chama-serviço-externo)). |
| `SUGGESTION_ROUTE_MAX_AGE_MIN` | `1440` | Minutos em que `/suggestions` reaproveita a rota habitual guardada antes de pedir outra ao Valhalla. |
| `SUGGESTION_ROUTE_RADIUS_M` | `250` | Distância máxima, em metros, entre a origem e o destino do pedido e os pontos da rota guardada para ela ainda valer. |
| `REGIONAL_HOLIDAYS` | `on` | Feriados estaduais e municipais no ETA. A cada plano, a API pergunta ao Photon o estado e o município da origem, mandando só o centro de uma célula geohash de cerca de 1,2 × 0,6 km, e guarda a resposta em memória por 7 dias. Se o Photon falhar, o ETA usa só os feriados nacionais. Com `off`, a API não faz a consulta. |
| `OPEN_METEO_URL` | `https://api.open-meteo.com` | Serviço de clima. |
| `CORS_ORIGIN` | qualquer origem | Uma origem só, para limitar quem chama a API pelo navegador. O app nativo não usa CORS. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` ou `trace`. |
| `USER_AGENT` | `Wayboo/0.1 (+https://github.com/caiorg/wayboo)` | Enviado ao Valhalla, ao Photon e ao Open-Meteo. |
| `HOST` | `0.0.0.0` | Interface em que a API escuta. |
| `AUTH_DEVICE_RATE_LIMIT` | `30` | Requisições a `POST /auth/device` (registro de aparelho) por IP a cada janela. A contagem vem antes da validação, então tentativas com corpo inválido também contam. IPv6 conta pelo /64. Acima do limite, a API responde 429. Com `0`, não há limite. |
| `AUTH_DEVICE_RATE_WINDOW_MIN` | `60` | Duração da janela do limite, em minutos. |

O `docker-compose.yml` fixa `PORT`, `DB_PATH`, `VALHALLA_URL`, `PHOTON_URL`, `MAP_STYLE_URL`, `MAP_STYLE_DARK_URL` e `TRUST_PROXY`, porque o gateway e os volumes dependem delas. O valor dessas no `.env` não tem efeito. O serviço `map-assets` recebe só `PUBLIC_URL` e grava em `MAP_DIR` (padrão `/srv/map`, o volume `map`). Os padrões dessas variáveis, válidos para a API fora do Compose, estão no `.env.example`.

O limite de registro usa o IP que o gateway repassa em `X-Forwarded-For`. O Compose fixa `TRUST_PROXY=uniquelocal`, e o Caddy descarta o cabeçalho enviado pelo cliente.

Com outro proxy na frente do Caddy, por exemplo com `GATEWAY_BIND=127.0.0.1` e o TLS terminado fora, todo cliente chega com o IP desse proxy e divide o mesmo limite. Para corrigir:

1. Configure o proxy para substituir o `X-Forwarded-For` pelo IP do cliente, descartando o valor que o cliente enviou. No nginx, use `proxy_set_header X-Forwarded-For $remote_addr;`, e não `$proxy_add_x_forwarded_for`. Em outro proxy, apague o cabeçalho recebido antes de gravar o novo. Só acrescentar não basta: `TRUST_PROXY=uniquelocal` confia em todo IP privado, inclusive o de um cliente na rede local, e a API passaria a usar o valor que esse cliente forjou.
2. Descubra o endereço do proxy que o Caddy enxerga. Com o proxy na mesma máquina, a conexão chega pela porta publicada, e o Caddy enxerga o gateway da rede do Compose, não `127.0.0.1`: `docker network inspect wayboo_default --format '{{(index .IPAM.Config 0).Gateway}}'`. Com o proxy em outra máquina, o Caddy enxerga o IP dela.
3. Declare esse endereço em `trusted_proxies`, dentro de `servers`, no bloco de opções globais do topo do `selfhost/Caddyfile`. O arquivo não traz essa diretiva:

   ```caddyfile
   {
   	admin off
   	servers {
   		trusted_proxies static 172.18.0.1/32
   	}
   }
   ```

   Depois rode `docker compose restart gateway`, porque o Caddyfile montado não recria o contêiner com `up -d`.

Se o endereço do passo 2 for público, inclua-o também em `TRUST_PROXY` no `docker-compose.yml`, por exemplo `TRUST_PROXY: uniquelocal,203.0.113.10`, porque `uniquelocal` cobre só redes privadas. O valor do `.env` não tem efeito, porque o Compose fixa essa variável. Depois rode `docker compose up -d api`, que recria a API com o valor novo; reiniciar o `gateway` não muda a API. Com um endereço privado, como o gateway da rede do Compose, `uniquelocal` já basta.

### Ollama na mesma máquina

Use `AI_BASE_URL=http://host.docker.internal:11434/v1`. O serviço `api` do `docker-compose.yml` mapeia esse nome para a máquina com `extra_hosts: host.docker.internal:host-gateway`, então ele resolve no Linux sem arquivo extra. O Docker Desktop já cria o nome, e nele `host-gateway` aponta para o mesmo endereço do host. No Docker Engine do Linux, `host-gateway` vira o IP da interface `docker0`, a bridge padrão (em geral `172.17.0.1`). O Docker Engine aceita esse valor a partir da versão 20.10.

A variável `HOST_GATEWAY` do `.env` troca esse destino por um IP. Ela vale para qualquer instalação, com ou sem Ollama, porque o Docker recusa criar a API quando não consegue resolver `host-gateway`:

- Daemon sem bridge padrão (`"bridge": "none"` no `daemon.json`) e sem `host-gateway-ip`: defina `host-gateway-ip` no `daemon.json` com um IP da máquina, que não muda, e reinicie o Docker (`sudo systemctl restart docker`) para o daemon ler a mudança. Ou use em `HOST_GATEWAY` o gateway da rede do Compose (`docker network inspect wayboo_default --format '{{(index .IPAM.Config 0).Gateway}}'`). Esse gateway pode mudar quando a rede é recriada (por exemplo, após `docker compose down`). Nesse caso, suba a stack com `docker compose up -d`, que recria a rede, confira o novo gateway, atualize o `.env` e rode `docker compose up -d api`.
- Docker rootless com `slirp4netns`: `host-gateway` aponta para a bridge dentro do namespace do daemon, não para a máquina ([moby/moby#47684](https://github.com/moby/moby/issues/47684)). Use em `HOST_GATEWAY` o IP da máquina na rede local, com o Ollama escutando nesse IP ou em `0.0.0.0`. O `slirp4netns` abre a conexão a partir da própria máquina, então ela passa pelo `ufw` sem regra extra, e a regra abaixo não se aplica. Não desligue a proteção do loopback do rootless (`DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false`). Isso deixaria qualquer contêiner alcançar todos os serviços da máquina em `127.0.0.1`, não só o Ollama.

Depois de mudar `HOST_GATEWAY`, rode `docker compose up -d api`.

Por padrão, o Ollama escuta só em `127.0.0.1:11434`, que o contêiner não alcança no Docker Engine comum. Defina `OLLAMA_HOST=0.0.0.0:11434` no serviço do Ollama. Isso abre a porta 11434 para a rede: restrinja o acesso a ela no firewall da máquina, porque o Ollama não pede autenticação. Se o firewall bloqueia conexões de entrada por padrão (o `ufw`, por exemplo), libere a 11434 só para a interface e a sub-rede da rede do Compose. Uma faixa ampla como `172.16.0.0/12` também cobre máquinas da LAN que usem endereços nela. Com a stack no ar:

```sh
net=$(docker network inspect wayboo_default --format '{{.Id}}')
subnet=$(docker network inspect wayboo_default --format '{{(index .IPAM.Config 0).Subnet}}')
sudo ufw allow in on "br-$(printf '%.12s' "$net")" from "$subnet" to any port 11434 proto tcp
```

A interface `br-…` e a sub-rede mudam se a rede for recriada (por exemplo, após `docker compose down`). Nesse caso, apague a regra antiga com `sudo ufw delete` e crie de novo. Se `HOST_GATEWAY` usa o gateway dessa rede, atualize-o também.

## HTTPS

Por padrão o gateway serve HTTP. Nesse modo, o token do aparelho e as rotas passam em texto claro, e qualquer um na mesma rede pode lê-los. Use HTTP só numa rede em que você confia, ou por uma VPN como Tailscale ou WireGuard.

Com um domínio que aponta para a máquina e as portas 80 e 443 abertas na internet, o Caddy emite e renova o certificado sozinho (Let's Encrypt):

```sh
GATEWAY_ADDRESS=wayboo.example.com
GATEWAY_PORT=80
GATEWAY_HTTPS_PORT=443
PUBLIC_URL=https://wayboo.example.com
```

A renovação do certificado é uma chamada externa periódica. Os certificados ficam no volume `caddy`.

Se outro proxy já termina o TLS, deixe `GATEWAY_ADDRESS=:80` e publique o gateway só para esse proxy com `GATEWAY_BIND=127.0.0.1`. Assim ninguém na rede chega ao HTTP direto.

## O que ainda chama serviço externo

- Clima: a API consulta o Open-Meteo (`OPEN_METEO_URL`). Sem acesso, o ETA segue sem o fator clima.
- IA: só se o `.env` configurar um provedor remoto, ou se o usuário cadastrar a própria chave em Ajustes (o app a manda nos cabeçalhos `x-ai-*`). Nesse caso, a API repassa a chave ao provedor escolhido sem gravá-la (ver `docs/privacidade.md`). `AI_PROVIDER=ollama` com um Ollama na rede local mantém tudo dentro.
- Preparo: extrato (Geofabrik ou a URL configurada), dados auxiliares do Planetiler, índice do Photon, estilos, fontes e sprites do OpenFreeMap e a tabela de velocidades padrão do Valhalla. Tudo isso é baixado uma vez e fica nos volumes.

O índice do Photon não se atualiza sozinho (`UPDATE_STRATEGY=DISABLED`), porque a atualização baixaria o índice de novo de um espelho externo. Para atualizar, apague o volume e suba de novo:

```sh
docker compose rm -sf photon && docker volume rm wayboo_photon && docker compose up -d
```

## Atualizar os dados

- Mapa e rotas: o mesmo `OSM_EXTRACT_URL` não baixa de novo. Para buscar um extrato mais novo, apague o arquivo. Para trocar de região, mude `OSM_EXTRACT_URL` no `.env`. Nos dois casos, suba de novo e reinicie `valhalla` e `tiles`:

  ```sh
  docker compose run --rm osm-extract rm /custom_files/region.osm.pbf   # só para atualizar a mesma URL
  docker compose up -d
  docker compose restart valhalla tiles
  ```

  O `osm-extract` grava o sha256 do extrato. Se o conteúdo mudou, ele apaga o grafo e o banco de limites do Valhalla, e o `tiles-build` gera um novo PMTiles. O `docker compose up -d` não reinicia contêineres que já estão rodando. Por isso o `restart` é necessário: ao iniciar sem grafo, o Valhalla o reconstrói, e o `go-pmtiles` passa a ler o arquivo novo. Se o conteúdo não mudou, nada é refeito. A geração dos tiles grava em `build/` e só troca o arquivo no fim, então uma interrupção mantém o mapa anterior.

- Feriados estaduais e municipais: vêm de `apps/api/src/data/holidays-br.json`, gerado a partir do dataset [joaopbini/feriados-brasil](https://github.com/joaopbini/feriados-brasil) (MIT). Cada feriado vale em qualquer ano pela data fixa ou pela distância da Páscoa, conforme os três anos anteriores do dataset. Os que já mudaram de data (transferidos) valem só no último ano do dataset. Quando o dataset publicar um ano novo, gere o arquivo de novo e publique a imagem:

  ```sh
  git clone --depth 1 https://github.com/joaopbini/feriados-brasil.git /tmp/feriados-brasil
  cd apps/api && bun src/scripts/holidays-import.ts /tmp/feriados-brasil
  ```

  O script aplica as correções de `CORRECTIONS` (em `holidays-import.ts`), conferidas em lei, onde o dataset diverge da fonte oficial. Se o dataset novo já corrigir um desses casos, ou mudar a regra que a correção remove, o script para com `Correção de <UF>: a regra ... não existe mais no dataset`. Confira de novo a fonte citada na correção, ajuste ou apague a entrada e rode outra vez. Depois, rode `bun run test` em `apps/api`: `test/holidays.test.ts` cobre as correções.

- Estilos do mapa: apague `upstream/` no volume `map` para baixar os estilos atuais do OpenFreeMap:

  ```sh
  docker compose run --rm map-assets sh -c 'rm -rf /srv/map/upstream'
  docker compose up -d
  ```

## Volumes

| Volume | Conteúdo |
| --- | --- |
| `osm` | extrato `.pbf` e grafo do Valhalla |
| `tiles` | `region.pmtiles` e dados auxiliares do Planetiler |
| `map` | estilos, fontes e sprites |
| `photon` | índice do Photon |
| `api` | banco SQLite da API |
| `caddy` | certificados do HTTPS |

`docker compose down -v` apaga todos, inclusive o banco da API.
