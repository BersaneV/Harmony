# Atualizações assinadas do Harmony

Desde a versão 0.2.0, o Harmony inclui atualizador para Windows x64. Em Preferências → Atualizações, o usuário consulta, baixa/verifica e escolhe instalar. A instalação fecha o aplicativo e interrompe chamadas; nada é instalado em segundo plano sem essa ação. No navegador, o aplicativo é atualizado pelo administrador do servidor.

O cliente fixa a chave pública e o feed HTTPS `https://github.com/BersaneV/Harmony/releases/download/update-channel/latest.json`. O renderer não fornece URL, chave, bytes nem argumentos de instalador. O processo Rust exige semver crescente, caminho exato da release Harmony e HTTPS também nos redirecionamentos GitHub/CDN. O limite de pacote é 128 MiB; há timeout, cancelamento e exclusão mútua de operações. Só bytes retornados após verificação de assinatura e versão são mantidos para instalação. Ao fechar o processo, um download deve ser repetido.

A verificação usa o plugin oficial Tauri 2.13.3 e minisign-verify0.3, com `requireSignedVersion=true` e `allowDowngrades=false`. A assinatura Ed25519 autentica os bytes e o comentário confiável contendo a versão. Reanunciar um pacote antigo como versão nova é rejeitado. O feed por si só não possui assinatura: quem controla o GitHub pode interromper/disponibilizar o canal, mas não criar um pacote novo válido sem a chave privada. A chave está fixada no aplicativo; rotação exige migração assinada por uma chave ainda confiável ou reinstalação conferida externamente.

A assinatura do atualizador **não é Authenticode**. O Windows pode exibir avisos de editor desconhecido/SmartScreen. Não se afirma reputação do executável nem homologação de atualização numa máquina física. A versão 0.1.0 anterior não continha updater; para adotar o canal é necessário instalar a versão atual manualmente uma vez.

## Custódia e publicação

A chave privada e sua senha ficam fora do Git, no diretório local ignorado `.local/signing` com diretório 0700/arquivos 0600; o repositório usa os secrets criptografados `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Preserve cópia criptografada independente dos dois arquivos antes de substituir/perder este computador. Não publique a chave nem a senha em issue, log, variável do frontend ou arquivo de configuração versionado. O arquivo `.pub` é público.

Pushes comuns executam testes e empacotamento sem assinatura de distribuição. A ação manual `Verify and build Harmony`, `package=true`, na `main`, gera o pacote assinado e uma release draft `v<versão>`. Antes da release, o próprio Windows CI verifica o artefato com o plugin e executa testes negativos de assinatura/versão. A chave só é entregue à etapa de build assinada.

Após conferir a execução, usar `scripts/publish-update.py --version <versão>` com o GitHub CLI autenticado como BersaneV e o probe `tools/updater-check` compilado. O script baixa o draft, compara hashes, repete a verificação criptográfica local, publica a versão como prerelease e atualiza o feed. Não roda automaticamente em push. Mudanças futuras devem aumentar a versão no package.json, package-lock.json e projeto Tauri; nunca substituir um instalador de uma versão já publicada. O canal aponta somente para um pacote versionado.

Referências: [Tauri Updater](https://v2.tauri.app/plugin/updater/), [releases do plugin](https://v2.tauri.app/release/updater/). A evidência e a manutenção da correção local de download estão em `vendor/tauri-plugin-updater/HARMONY-PATCH.md`.

## Primeira publicação

A release [0.2.0](https://github.com/BersaneV/Harmony/releases/tag/v0.2.0) e o canal público estão ativos. O artefato passou por assinatura/versão e instalação/remoção no Windows CI; o feed foi consultado por HTTPS com download e verificação reais. Veja VALIDATION.md para SHA, execução e limites. O publicador local trata drafts por listagem autorizada: o endpoint por tag pode retornar404 antes de existir uma referência Git publicada.

## Publicação anterior: 0.3.0

A [prévia 0.3.0 para Windows x64](https://github.com/BersaneV/Harmony/releases/tag/v0.3.0) foi publicada após a execução [43307922953](https://github.com/BersaneV/Harmony/actions/runs/43307922953), no código `c22bb12fdfe75aaa1b20e6f5382fc4049660e34c`. Assinatura/versão e instalação/remoção passaram no Windows; a assinatura foi repetida localmente no arquivo baixado. A consulta HTTPS pública confirmou atualização de 0.2.0 para 0.3.0 e ausência de atualização para quem já está na 0.3.0. O teste usa o plugin real sem executar a instalação no Mac; a atualização sobre uma instalação física em uso ainda precisa de homologação. Os hashes, relatórios e limites estão em [VALIDATION.md](VALIDATION.md).

## Canal atual: 0.4.0

A [prévia 0.4.0 para Windows x64](https://github.com/BersaneV/Harmony/releases/tag/v0.4.0) foi publicada após a execução [43486904230](https://github.com/BersaneV/Harmony/actions/runs/43486904230), no código `b106af26f9ed06e579bbaedc16aa75b30d9f9a0d`. O artefato passou por 17 verificações de assinatura/versão e nove de instalação/remoção no Windows CI; a verificação criptográfica foi repetida no download local. O feed público ofereceu 0.4.0 para 0.3.0 e retornou `no_update` para 0.4.0. O alvo Windows no probe é explícito, mas sua execução usa MockRuntime e não instala no Mac. Captura e atualização sobre instalação física em uso continuam sem homologação.

Atualize servidor e clientes juntos ao ativar P2P: o servidor 0.4 em modo P2P recusa a rota LiveKit usada pelos clientes antigos. A configuração e o corte estão em [OPERATIONS.md](OPERATIONS.md), e as evidências completas em [VALIDATION.md](VALIDATION.md).
