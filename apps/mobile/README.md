# Wayboo mobile

App Expo (SDK 58) com Expo Router. Na web, roda com `bun run web` na raiz. No Android e no iOS, o app usa módulos nativos que o Expo Go não traz (MapLibre, `expo-secure-store`, `expo-file-system`, `expo-sharing`), então precisa de um development build.

Os comandos abaixo rodam em `apps/mobile`. As pastas `ios/` e `android/` são geradas pelo `expo prebuild` e ficam fora do git. Mudanças nativas vão em `app.json` e nos config plugins.

## Development build

O development build é o app com `expo-dev-client`. Ele instala uma vez e carrega o JavaScript do Metro da sua máquina, como o Expo Go. Gere um build novo quando mudar dependência nativa, plugin ou `app.json`. Mudança só de JavaScript não pede build novo.

### Local

Pré-requisitos (versões do [SDK 58](https://docs.expo.dev/versions/v58.0.0/)):

- iOS: macOS com Xcode 26.4 ou mais novo e CocoaPods (`brew install cocoapods`). Se `xcode-select -p` apontar para as Command Line Tools, rode `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` ou exporte `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Android: JDK 17 (`brew install --cask zulu@17`), Android Studio com o Android SDK e `ANDROID_HOME` configurado. Veja o [guia de ambiente](https://docs.expo.dev/get-started/set-up-your-environment/).

```bash
bunx expo run:ios               # compila, instala no simulador e abre o Metro
bunx expo run:ios --device      # iPhone ligado por cabo (pede time de assinatura no Xcode)
bunx expo run:android           # emulador ou aparelho com depuração USB
```

O primeiro build demora, porque o `pod install` baixa o MapLibre pelo Swift Package Manager e o Gradle baixa as dependências do Android.

### Pela nuvem (EAS)

Precisa de conta Expo. O `eas init` cria o projeto no EAS e grava `extra.eas.projectId` no `app.json`. Faça o commit dessa mudança.

```bash
bunx eas-cli login
bunx eas-cli init
bunx eas-cli build --profile development --platform android   # APK
bunx eas-cli build --profile development --platform ios       # .app para o simulador
```

No fim, o EAS mostra um link e um QR code. No Android, abra o link no aparelho e instale o APK. No simulador iOS, `bunx eas-cli build:run -p ios --latest` baixa e instala o último build.

Perfis do `eas.json`:

| Perfil | O que gera |
|---|---|
| `development` | dev client; APK no Android e build de simulador no iOS. Não pede conta Apple paga. |
| `development-device` | dev client para iPhone físico. Pede conta Apple Developer paga e o aparelho registrado com `bunx eas-cli device:create`. |
| `preview` | app sem dev client, com o JavaScript embutido, para testar sem o Metro. |

O `preview` não tem o IP do Metro, então a URL da API cai em `localhost`. Defina `EXPO_PUBLIC_API_URL` nas [variáveis de ambiente do EAS](https://docs.expo.dev/eas/environment-variables/) com uma URL HTTPS. O Android bloqueia HTTP sem TLS em build release.

## Abrir o app no build

1. Na raiz, suba a API: `bun run api`.
2. Em `apps/mobile`, suba o Metro: `bunx expo start`. Com o `expo-dev-client` instalado, o Metro abre no development build por padrão.
3. Abra o Wayboo no aparelho. Ele lista os servidores Metro da rede. Se não aparecer, leia o QR code do terminal com a câmera.

O app chama a API em `http://<IP da máquina do Metro>:8787`. O aparelho precisa estar na mesma rede que a máquina. Com VPN no celular ou rede que isola os aparelhos, exponha a API por um túnel HTTPS (`cloudflared tunnel --url http://localhost:8787`) e rode o Metro com `EXPO_PUBLIC_API_URL=<url do túnel>`. A URL também pode ser trocada em Ajustes.
