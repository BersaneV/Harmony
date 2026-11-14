# Validação da versão de desenvolvimento

Data: 12/11/2026. A implementação está na `main`. Esta página distingue código entregue, provas executadas e aceite operacional. Os testes locais usam dados descartáveis; senhas, tokens, bancos e pacotes proprietários analisados não estão no Git.

Os primeiros quadros preservam a evidência histórica da implementação inicial. A publicação atual está registrada em **Release 0.4.0 publicada e conferida**, ao final desta página.

## Caminhos executados

| Recorte | Prova | Resultado e limite |
|---|---|---|
| Servidor Rust | fmt, clippy sem warnings, testes de domínio e PostgreSQL | 15 testes PASS local; inclui rotação concorrente, idempotência, sequenciamento e ACL. |
| HTTP/WS/S3/LiveKit | `scripts/smoke.mjs` com banco, storage e SFU reais | 63 verificações PASS, repetidas após inclusão de ACL; não é teste de captura Windows. |
| Cargos e canais | `crates/server/tests/acl.mjs` | 103 verificações PASS, incluindo acesso cruzado, revogação, permissões de espectador e tamanho do PUT assinado. |
| Cliente React | TypeScript, 37 testes Vitest e build Vite | PASS; cenários incluem sessões, reconexão, perfis de mídia e controles de permissão. |
| Desktop nativo | Testes e clippy do adaptador Tauri no macOS | PASS; não comprova cofre, PTT ou captura em Windows. |
| Moderação na interface | Membro conectado, mute/unmute via API real e eventos do SDK | PASS: controles de publicação bloqueiam e depois liberam, sem ativar dispositivos. |
| Navegação real | Login, comunidade, chat, edição, reação, membros, cargo/override, upload/prévia e entrada/saída de chamada | PASS em navegador local. Microfone/câmera não foram ativados. |
| Gateway público | `scripts/test_media_proxy.py`, Caddy real com TLS/L4/PROXYv2 | 16 cenários PASS; backends controlados, certificados locais. Inclui teto de corpo de upload e precedência de credenciais. |
| Sessão de mídia | `scripts/test-media-admission.mjs` | 9 critérios PASS com API, PostgreSQL, Caddy e LiveKit reais. Testa sinalização e revogação, sem negociação RTC completa. |
| Áudio e vídeo WebRTC | `scripts/test_media_rtc.py`, dois clientes SDK | 17 critérios PASS; 71 frames de áudio e 10 frames VP8 sintéticos 160×96. Reset desconectou o emissor em 0,334s nesse ensaio e bloqueou reconexão. Ver [escopo completo](MEDIA-RTC-VALIDATION.md). |
| Permissão durante RTC | Ensaio independente de revogar/restaurar publicação e revogar conexão | 25 critérios PASS após corrigir leitura de `can_publish` no retorno Twirp. Perda de CONNECT desconectou o emissor em3,969s na repetição pública; receptor permaneceu conectado. |
| Recuperação | Dump/restore em banco descartável | Ver [ensaio de restauração](RESTORE-VALIDATION.md); não substitui restauração integral em host independente. |
| Análise Discord | REA estático do pacote oficial macOS | Concluída no recorte descrito em [REA-DISCORD.md](REA-DISCORD.md), sem executar o Discord nem incorporar código proprietário. |

As contagens pertencem ao ensaio descrito; não medem percentual de produto pronto. Os relatórios locais ficam em `.local`, ignorados pelo Git. O histórico das execuções de CI fica em [GitHub Actions](https://github.com/BersaneV/Harmony/actions/workflows/verify.yml), com o SHA exato de cada execução.

## Repetir as provas

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
python3 scripts/with-env.py cargo test --workspace --locked -- --include-ignored
npm ci
npm run typecheck
npm test
npm run build
HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 python3 scripts/with-env.py node scripts/smoke.mjs
HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 python3 scripts/with-env.py node crates/server/tests/acl.mjs
CADDY_BIN=/caminho/para/caddy-com-l4 HARMONY_REQUIRE_CADDY=1 python3 -m unittest discover -s scripts -p 'test_*.py'
```

Configure serviços e credenciais descartáveis primeiro. O teste Caddy usa portas temporárias e não precisa abrir a rede. Sem o binário apropriado, o teste normalmente fica SKIP; `HARMONY_REQUIRE_CADDY=1` transforma ausência em erro. O CI não deve ser interpretado como prova desse cenário quando ele foi pulado.

## Antes de convidar usuários externos

- Instalar e executar o `.exe` em Windows 11 x64; testar captura de monitor/janela, cancelamento, áudio da tela, eco, dispositivos, F9, suspensão e retomada.
- Medir 1440p/2160p e cada perfil de FPS/bitrate em máquinas reais. A seleção do perfil não garante que o hardware ou a rede o sustentem.
- Validar o host, DNS/certificados e tráfego entre redes diferentes, incluindo UDP bloqueado e TURN/TLS443.
- Integrar quotas de rede e disco ao host escolhido. O teto do encoder e a cota lógica de anexos não são um bloqueio de cobrança do provedor.
- Executar backup cifrado e restauração conjunta de banco, objetos e chaves em destino independente.
- Homologar instalação/remoção e distribuição. O instalador inicial não tem assinatura Authenticode; o updater assinado está implementado na versão 0.2.0 e exige ação explícita para instalar; a atualização em máquina física continua sem homologação.

## Instalador Windows

A execução inicial [43267311874](https://github.com/BersaneV/Harmony/actions/runs/43267311874), SHA1247446, passou nos jobs Linux e Windows, incluindo o empacotamento NSIS. As correções posteriores são verificadas em nova execução vinculada ao SHA da release. O artefato é de desenvolvimento, sem Authenticode e sem homologação física Windows.

## Dependências

Inventário de 825 versões de pacotes Cargo e npm, com 388 textos distintos de licenças/avisos extraídos dos pacotes, com espaços de fim de linha normalizados somente na cópia gerada. Inclui dependências de build e de outras plataformas por precaução. Todos declararam licença; 49 pacotes não traziam arquivo de aviso na localização inventariada e mantêm link para a fonte. Isso não é uma declaração de revisão jurídica completa. `scripts/license-inventory.py` regenera os arquivos; os avisos são incluídos nos recursos do instalador. Imagens de infraestrutura estão fixadas por digest em `infra/images.lock.json`. Auditoria npm da base: zero vulnerabilidades reportadas.

## Funcionalidades ainda fora desta implementação

Prévias automáticas de links, rascunhos persistentes offline, transferência de participante entre salas, menções com notificação dedicada e camadas SVC/simulcast permanecem no roadmap. O cliente usa um encoder VP8 para a transmissão inicial. Threads/fóruns, palco, soundboard, PiP, webhooks, atividade de jogos e E2EE são extensões separadas.

O projeto pode ser desenvolvido e ensaiado localmente sem contratar serviços. Não foi provisionado servidor público nem criada garantia de disponibilidade ou gratuidade permanente.

## Extensão 0.2.0 — worker, atualização e personalização

Os três recortes solicitados foram implementados. [Worker de mídia](MEDIA-WORKER.md), [atualizações assinadas](UPDATES.md), [personalização](PERSONALIZATION.md) e [revisão de segurança](SECURITY-EXTENSIONS.md) descrevem contratos e limites.

- Worker: 51 critérios locais com PostgreSQL/S3/FFmpeg 9.0.2 reais, incluindo imagem/GIF/vídeo/áudio, JPEG privado, MP4 faststart, preservação do original, revogação VIEW, quota de derivados/reservas, disputa entre workers, três retries, lease após kill, fencing de processo antigo e limpeza.
- Updater: 16 critérios do plugin oficial com extensão local de limite, incluindo adulteração de bytes/assinatura, chave incorreta, versão adulterada, downgrade, mesma versão, Content-Length excessivo, stream sem comprimento e cancelamento. O guard antigo de cancelamento falhou em dois testes de consumo, foi substituído pelo limite antes de acumular bytes e voltou a passar. Testes nativos de URL/versão/concorrrência e Clippy passaram.
- Frontend: 65 testes, typecheck e build passaram; inclui testes que reproduziram e corrigiram a concorrência entre salvar perfil e renovar sessão. A validação visual real usa dados/arquivos de teste, não dados pessoais. Confirmou importação PNG/TTF, cancelamento, JSON inválido, aplicar/Salvo, exportar/reimportar e persistência após novo login. Anexo PNG enviado pela interface exibiu status processado e metadados640×360 no visualizador; arquivos locais de evidência: `.local/qa/personalizacao-0.2.0.jpg` e `.local/qa/worker-previa-0.2.0.jpg`.

A etapa Linux de CI repete os testes do worker e executa preflight da imagem isolada; a etapa Windows compila o NSIS, testa a política nativa e verifica a assinatura do artefato real antes de criar o draft. Consultar a execução e o SHA da release para o resultado remoto. A verificação criptográfica não executa o instalador e não substitui ensaio físico Windows.

## Release 0.2.0 publicada e conferida

Código empacotado: `a4912d6f96a039f69617042c7404120e2f17f2db`. A execução [43276140568](https://github.com/BersaneV/Harmony/actions/runs/43276140568) terminou com **sucesso nos jobs Linux e Windows**. No Linux: 51 critérios do worker com PG/S3/FFmpeg 9.0.2, seis negativos do sandbox e preflight da imagem final passaram, além dos testes Rust, smokeHTTP/WS e 103 critérios ACL. No Windows: 65 testes do frontend, quatro testes independentes de tema, testes nativos, build NSIS assinado, 17 critérios de assinatura/versão/download com o artefato real e nove critérios de instalação/remoção silenciosas passaram.

A primeira execução deste recorte falhou por inferência do tipo do monitor no caminho Linux. O código foi corrigido, conferido para x86_64/aarch64 Linux e executado novamente no CI. O teste com substitutos no macOS após a correção ficou em `.local/qa-worker-sandbox/linux-monitor-fix-macos.json`; resultados históricos anteriores foram preservados.

[Release pública 0.2.0](https://github.com/BersaneV/Harmony/releases/tag/v0.2.0), marcada como prévia. Artefato: `Harmony_0.2.0_x64-setup.exe`, 4035172 bytes. SHA-256: `a59925e6fd825b88b9ed1468520256a6c9bf51a520fc04b1d2105829c9585bfb`. Manifesto de hashes, assinatura e relatórios Windows estão anexos à release. O download local repetiu os 17 critérios e coincidiu com o hash publicado pelo GitHub.

O probe `public-channel` acessou o [feed HTTPS real](https://github.com/BersaneV/Harmony/releases/download/update-channel/latest.json), sem autenticação nem exceção HTTP. Com versão corrente simulada 0.1.0: ofereceu 0.2.0, baixou 4035172 bytes e verificou a assinatura/versão com o mesmo SHA acima. Com 0.2.0: retornou `no_update`. Os JSONs `public-channel-upgrade.json` e `public-channel-current.json` estão anexos à release. Esse probe usa MockRuntime com alvo Windows x64; ele não executa o instalador. O teste de instalação/remoção separado ocorreu realmente no runner Windows.

Permanecem sem homologação física: atualização sobre uma instalação usada no dia a dia, captura/áudio/dispositivos Windows, desempenho 1440p/2160p, redes externas/TURN e host definitivo. Não houve provisionamento pago. A assinatura do updater não equivale a Authenticode.

## Perfil simplificado 0.3.0 — provas locais

SQLite e arquivos locais substituem os serviços PostgreSQL/S3 na execução normal; as provas acima identificam a implementação histórica. As migrações preservaram as fontes e foram feitas em destinos descartáveis. Resultados do perfil novo:

- Rust: 33 testes incluindo concorrência/lock/ACL; Clippy sem warnings. HTTP/WS: 63 critérios; ACL: 103; armazenamento local: 29 com worker; FFmpeg/queue: 51 critérios.
- Importação PostgreSQL: 25 tabelas e 934 linhas verificadas, seguida por migration/backfill; 5 testes negativos/atomicidade. Objetos S3: 65 copiados e conferidos em snapshot de ensaio, com 8 negativos de migração. Isso não é corte da implantação original.
- Busca: oracle PostgreSQL real com 416 casos/69 consultas; revisão independente do parser C e harness ASan/UBSan com 40.000 entradas e concorrência. View ACL conferida em 12.000 combinações/60.000 assertivas. Não afirma equivalência universal entre versões/locales Unicode nem ausência universal de falhas em C.
- Backup/restauração: 7 testes; supervisor: 2; configuração: 5. Gateway Caddy real: 16 critérios de proxy/admission/limites. Revisão independente identificou e levou à correção da ordem das variáveis no CI e da execução dos scripts via `sh`.
- P2P: 34 verificações em dois processos Chromium no mesmo computador, vídeo sintético 720p/1440p a 30 FPS e RTT local mediano de 0,9 ms. Esse número não mede a rede móvel, não representa captura de jogo e não comprova redução dos 137 ms externos. O ensaio WAN posterior está registrado abaixo.

A publicação 0.3.0, execução Linux/Windows dessa versão, restauração Docker real e homologação física Windows devem receber seus resultados próprios. Não herdam automaticamente PASS da versão 0.2.0.

### Ensaio WAN com celular 5G

Em 12/11/2026 às 16:35 BRT, o usuário confirmou Android no 5G com Wi-Fi desligado e recebeu o vídeo enviado pelo navegador do Mac. O diagnóstico durou 119,5s, incluindo cerca de 64s de espera pela entrada do participante; foram colhidas 56 amostras conectadas. A rota ICE foi direta UDP (tipos host/host), sem relay contratado. O relatório exportado não inclui IPs, tokens ou SDP.

Resultado no emissor: ping de aplicação mediano60,2ms/p95 681,2ms; RTT ICE mediano46ms (32–642ms). Dos55 pings,47 retornaram,7 expiraram e1 estava pendente no encerramento. Isso não é medição de porcentagem de perda RTP. Vídeo sintético1280×720 solicitado30FPS/2Mb/s: FPS observado1–28, mediana6; bitrate mediano~0,089Mb/s. Conteúdo sintético não consome necessariamente o teto configurado. O receptor confirmou vídeo, mas seu relatório não foi coletado.

O resultado confirma conectividade entre redes e um ping central menor que a referência histórica137ms. Não é comparação A/B controlada: alvo, protocolo e condições diferem. A fluidez não passou no critério30FPS. Visibilidade das abas e carga dos dispositivos não foram registradas, e uma compilação local começou perto do encerramento; não é possível atribuir a instabilidade à rede ou a um componente específico. Windows físico, áudio/captura e teste prolongado continuam pendentes.

### Navegação responsiva

A seleção repetida da comunidade agora preserva canal, componente de chat e rascunho. Em até800px, a lista abre como painel com botãoCanais, X, backdrop e Escape; no desktop permanece lateral. Formulários, personalização e diagnóstico têm rolagem e controles adaptados. CUA verificou360/390/768/1280px, incluindo abertura/fechamento e rascunho preservado; em360×420 o campo de mensagem permaneceu inteiro e a página não excedeu a largura. O usuário confirmou acesso ao painel P2P no Android5G após recarregar. Isso não simula todos os teclados/dispositivos nem é homologação físicaWindows.

Depois da integração0.3.0:69testesVitest,4testesindependentesdetema,typecheck/build,33testesRust eClippy PASS. Inventário regenerado:816pacotes,392textosdeavisos,48semarquivolocal,nenhumsemdeclaraçãodelicença; parserPostgreSQL incluídoexplicitamentecomhasheseCOPYRIGHT.

Integração de mídia repetida em0.3.0/SQLite:9critérios do gateway de admissão e17critérios RTC PASS, com137frames de áudio sintético e10framesVP8 decodificados; reset desconectou o emissor em0,336s e impediu reconexão. O primeiro ensaio retornou403 porque a configuração isolada não havia habilitado o proxy local confiável; o controle foi mantido e a configuração de teste corrigida.28testesPython (incluindoCaddyreal) PASS. Docker/Windows remoto desta versão permanecem pendentes até o gateCI correspondente.

### Participação P2P sem código

O convite agora aparece automaticamente para quem abre o mesmo canal autorizado. A interface mostra o nome de quem iniciou e o botão Participar; o identificador fica restrito ao protocolo. CUA confirmou duas contas reais no mesmo Mac: iniciar, convite automático, um clique para entrar, vídeo recebido em 1280×720 a 29–30 FPS, encerramento de ambos e remoção do convite. Em 390×844 não houve excesso de largura e não havia campo de código. É uma prova local de interface/RTC, sem substituir o ensaio WAN anterior ou homologação física Windows.

A revisão independente identificou cache antigo após HTTP 403: a interface passou a ocultar convites quando perde permissão ou a consulta falha, e desabilita iniciar outro teste nesse estado. O botão de encerrar continua disponível durante o teste ativo. As chamadas normais continuam LiveKit.

A suíte independente de descoberta passou em 30 critérios contra a API/WS real, incluindo disputa simultânea pela vaga, isolamento entre canais, revogação de PUBLISH, mute, reset administrativo e prazo real de 120 segundos (observado 120.017 ms). Os eventos não expõem identificadores de teste e não chegam a quem está fora do canal. Frontend: 69 testes, typecheck e build passaram após a mudança.

### Cadastro aberto

A orientação de 12/11/2026 abriu o cadastro com usuário e senha, sem convite. O nome de exibição é opcional e usa o login quando omitido. Convites fornecidos explicitamente continuam sujeitos à validade e podem associar o usuário à comunidade; cadastro aberto não dá acesso administrativo nem entrada automática em comunidades privadas.

A suíte HTTP/WS passou em 71 critérios (antes63), incluindo cadastro anônimo sem convite, login posterior, rejeição de nome duplicado normalizado, senha curta e campo administrativo injetado, além de negar acesso administrativo e ao canal privado para a conta nova. CUA criou uma conta pelo formulário real sem convite/nome de exibição, recarregou e entrou novamente com a senha cadastrada. Frontend69 testes, typecheck e build passaram.

### Moderação com sessões antigas

O teste real reproduziu HTTP503 ao silenciar um usuário que tinha uma identidade antiga emitida, ausente do LiveKit, além de uma sessão ativa. A política já havia sido persistida, mas a resposta404 da identidade antiga interrompia a atualização das seguintes. A correção aceita como ausência somente HTTP404 com erro Twirp `not_found` em UpdateParticipant/RemoveParticipant; falhas genéricas, autenticação e demais operações continuam como erro.

Regressão RTC posterior: 26 critérios passaram com LiveKit/Caddy reais, incluindo mute/unmute, mudança de permissão no SDK, remoção da publicação e publicação novamente, além de áudio/vídeo e reset/reconexão. A primeira repetição detectou uma leitura imediata antes de ListParticipants refletir a republicação; o harness passou a aguardar o SID exato, mantendo o critério e preservando o resultado intermediário.

A revisão independente acrescentou seis verificações HTTP de cadastro: conta comum e nome canônico, convite explícito inválido sem criar conta, rollback do consumo do convite ao colidir nome, convite opcional válido associado à comunidade certa, convite esgotado sem criar usuário/associação e isolamento de contas públicas. Resultado PASS.

### Correções encontradas na implantação 0.3.0

A execução [43296555851](https://github.com/BersaneV/Harmony/actions/runs/43296555851) detectou opções de tmpfs interpretadas como mounts separados na lista YAML; as entradas passaram a ser strings entre aspas. A tentativa seguinte criou o contêiner, mas não alcançou readiness, e seu cleanup removeu os logs antes do diagnóstico. A coleta foi corrigida para ocorrer antes da remoção.

Com os logs preservados, a execução [43304407690](https://github.com/BersaneV/Harmony/actions/runs/43304407690) confirmou que o sandbox de mídia passava e a migração 2 falhava com SQLite6410 (`SQLITE_IOERR_GETTEMPPATH`): não havia diretório temporário gravável nos caminhos procurados pelo banco. A correção em `c22bb12` configura `SQLITE_TMPDIR` em tmpfs privado separado de 128 MiB, mantendo o filesystem da imagem somente leitura e os limites do parser. O CI agora verifica a escrita efetiva nas duas áreas temporárias como UID10001 e a recusa de escrita em `/tmp`.

A reprodução independente local usou o binário real `harmony-db`/SQLite3.51.3 em sandbox: sem o diretório, o mesmo erro6410 ocorreu na migração2; com a configuração corrigida, a migração passou. O mesmo banco antes falho foi recuperado, com `integrity_check=ok`, nenhuma violação de FK e migrações1/2 registradas uma única vez. Nova inicialização permaneceu íntegra e idempotente. Essa reprodução macOS não substitui a execução Compose/Linux da release.

## Release 0.3.0 publicada e conferida

Código empacotado: `c22bb12fdfe75aaa1b20e6f5382fc4049660e34c`. A execução [43307922953](https://github.com/BersaneV/Harmony/actions/runs/43307922953) passou nos jobs Linux e Windows. A [release pública 0.3.0](https://github.com/BersaneV/Harmony/releases/tag/v0.3.0) é uma prévia para testes e inclui cadastro aberto, comunidades com entrada controlada, navegação responsiva, participação P2P pelo canal e o perfil simplificado, preservando worker, personalização e atualizador.

- Linux: fmt/Clippy, 34 testes Rust, suítes Python e gateway Caddy real; 71 verificações HTTP/WS, 103 ACL, 29 armazenamento, 51 worker, seis negativas do sandbox, nove de admissão e 26 de RTC. Descoberta P2P passou em 30 critérios, incluindo expiração real; os dois navegadores no mesmo runner passaram em 34 verificações. A descoberta e o teste de vídeo continuam separados das chamadas LiveKit.
- Compose real: escrita nos dois tmpfs privados como UID10001 e `EROFS` no filesystem da imagem; inicialização e migrações da API, frontend HTTP, nova execução das 71 verificações, backup offline com cinco arquivos no manifesto, verificação e restauração em diretório novo, seguida de reinício saudável da instância original. A restauração não iniciou uma segunda instância nem um volume restaurado; recuperação operacional em outro host permanece pendente.
- Windows: typecheck, 69 testes frontend, quatro de tema e quatro de política nativa; NSIS gerado e assinado, 17 verificações do updater com artefato real e nove verificações de instalação/remoção silenciosas no runner. O aplicativo não foi aberto por esse teste de instalação.

Artefato: `Harmony_0.3.0_x64-setup.exe`, 4.042.098 bytes. SHA-256: `683fe9221dba8cd17c076f01d59a49e5a3a38c35e636e0b89cfb348b4c134536`. O download local coincidiu com o digest do GitHub e repetiu os 17 critérios de assinatura/versão. O executável da 0.2.0 foi preservado.

O probe do canal público acessou HTTPS sem autenticação: partindo de 0.2.0, ofereceu 0.3.0, baixou o instalador e verificou assinatura, versão e o mesmo SHA acima. Partindo de 0.3.0, retornou `no_update`. Os relatórios `public-channel-upgrade.json` e `public-channel-current.json` acompanham a release. Esse probe usa MockRuntime com alvo Windows x64 e não executa o instalador; a prova de instalação é a execução Windows separada.

Continuam pendentes: captura/áudio, atualização de uma instalação em uso e desempenho em Windows físico; fluidez sustentada no ensaio WAN; host externo definitivo gratuito e recuperação em destino independente. O diagnóstico P2P não converteu chamadas normais em P2P. O túnel de teste depende do computador de desenvolvimento. A assinatura do updater não é Authenticode.


## Chamadas reais P2P — provas locais 0.4.0, 13/11/2026

Esta entrega usa P2P nas chamadas reais por padrão e preserva LiveKit como modo explícito. A prova WAN do diagnóstico 0.3 não comprova a nova chamada. Consulte o [contrato e seus limites](P2P-CALLS.md) e a [evidência local com hashes dos arquivos](evidence/p2p-0.4.0-local.json).

- Protocolo: 59 critérios HTTP/WS em API, SQLite e arquivos reais descartáveis, sem LiveKit e com diagnóstico desabilitado. Abrange canal de voz, DM, grupo, concorrência, lotação, isolamento, limites de mensagens, reautenticação, logout/reset, expiração/replay, permissões e banco indisponível. Chamada ativa por 122,108 s; heartbeat de 35,007 s; mute em 23 ms, revogação de PUBLISH em 500 ms e CONNECT em 353 ms na amostra local.
- Mídia: 54 critérios em três processos Chrome 157 separados no mesmo Mac. Áudio gerado decodificado, quatro fontes distintas, três telas simultâneas, troca entre 720p e 1440p, bitrate/FPS aplicados por emissor, receptor em 360p enquanto outro mantém 1440p, captura real de uma aba própria via getDisplayMedia (1280×700 recebido, duas cores decodificadas), sessão de 125,003 s, moderação, reentrada, reset, perda de sinalização, liberação de recursos e falha SDP isolada. Nenhum microfone/câmera físico foi capturado. Sem STUN externo, relay ou LiveKit nesse ensaio.
- Perfil 1440p com teto de 15 FPS: 11,47 FPS decodificados na amostra. Verificou o limite e a recepção, não 15/30/60 FPS sustentados, captura de jogo ou redução do ping externo.
- Cliente: 81 testes unitários (12 da engine), TypeScript e build. CUA no frontend compilado verificou entrada pelo canal sem código, dispositivos inicialmente desligados, seleção de 1440p/60 FPS/4 Mb/s, cancelamento, painel de dispositivos, silenciar/reativar áudio e saída. Recebeu vídeo e áudio gerados de outro Chrome; a recepção de 720p/29 FPS mudou para 360p/29 FPS pelo seletor real. Foco, saída do emissor e saída da chamada funcionaram. Os controles permanecem visíveis em 1280×720 e têm alvos de 44 px em 360×420 e 390×844, sem excesso de largura; ajuste CSS revisado independentemente. Não executou captura física pela interface, medição acústica ou grade visual com mais de dois participantes.
- Servidor: 37 testes Rust incluindo integrações ignoradas, fmt/Clippy e 30 testes Python incluindo Caddy real. Inventário de 816 dependências e 392 avisos únicos, nenhuma declaração de licença ausente; sem dependências novas.
- Revisão independente sem bloqueios no recorte final. Corrigidos antes da publicação: áudio desmarcado após prévia, microfone recebido durante silenciamento, seleção de qualidade durante publicação, foco em participante que saiu, cancelamento interrompendo tela anterior, estatísticas nulas, falha SDP derrubando outros pares, saída gerando cascata de sinais e atividade LiveKit indevida no modo P2P.

O CI e a publicação foram concluídos no registro abaixo. Permanecem pendentes redes independentes para as chamadas reais, captura/áudio/atalho global/atualização sobre instalação em uso no Windows físico, capacidade com 12 participantes e hospedagem definitiva. A assinatura do atualizador não é Authenticode. A moderação dos clientes oficiais não impõe corte físico entre dois clientes modificados que cooperem para ignorá-la.

O piloto temporário foi atualizado para 0.4.0/P2P e seus assets públicos coincidiram com o build local, incluindo a correção dos controles. O ensaio de chamada real pelo túnel aguardou dez minutos sem entrada do celular: `GUEST_NOT_OBSERVED`, nenhum vídeo/tom publicado e nenhuma amostra de RTT externo. Não é uma falha de conectividade comprovada nem um teste WAN aprovado.

## Release 0.4.0 publicada e conferida

Código empacotado: `b106af26f9ed06e579bbaedc16aa75b30d9f9a0d`. A execução [43486904230](https://github.com/BersaneV/Harmony/actions/runs/43486904230) passou nos jobs Linux e Windows. A [prévia pública 0.4.0](https://github.com/BersaneV/Harmony/releases/tag/v0.4.0) inclui chamadas P2P reais, controles responsivos e os recursos anteriores. O [registro de CI e publicação](evidence/p2p-0.4.0-ci.json) identifica suítes, contagens e limites.

- Linux: 37 testes Rust, fmt/Clippy; 29 testes Python na descoberta e o teste obrigatório de proxy depois de construir Caddy. A classe de Caddy foi inicialmente pulada por ausência do binário e executada com sucesso na etapa posterior obrigatória. HTTP passou em 72 critérios tanto no modo LiveKit quanto no Compose P2P; ACL 103, armazenamento 29, worker 51, sandbox seis, admissão nove e RTC LiveKit 26. O diagnóstico anterior passou em 30 critérios de descoberta e 34 de navegador. Chamadas reais, com LiveKit e diagnóstico desabilitados: 59 critérios de protocolo e 54 de mídia.
- Compose: API e worker iniciados sem LiveKit; escrita nos dois diretórios temporários privados como UID10001, raiz somente leitura, backup de cinco arquivos, verificação de integridade, restauração para diretório separado e reinício saudável. A instância restaurada não foi iniciada; recuperação operacional em outro host continua pendente.
- Windows: TypeScript, 81 testes do cliente, quatro de temas e quatro de política nativa. NSIS gerado; 17 verificações de assinatura/versão e nove de instalação/remoção silenciosas passaram. O aplicativo não foi aberto nesse teste, e ele não comprova captura, áudio ou atualização sobre instalação física em uso.

Artefato: `Harmony_0.4.0_x64-setup.exe`, 4.058.308 bytes. SHA-256: `01405fa1b2039334c4f9dba40f10b3b2dc04da944e2537369dccd35de91b59b3`. O arquivo baixado coincidiu com o digest do GitHub e repetiu localmente os 17 critérios de assinatura/versão. As releases anteriores foram preservadas.

O probe HTTPS público ofereceu 0.4.0 para um cliente 0.3.0, baixou o instalador e verificou assinatura, versão e o mesmo SHA acima. Para um cliente 0.4.0, retornou `no_update`. Os relatórios `public-channel-upgrade.json` e `public-channel-current.json` acompanham a release. Esse probe usa MockRuntime com alvo Windows x64 e não executa o instalador.

As medições locais e de CI não comprovam ping ou conectividade entre redes diferentes. O ensaio 5G desta entrega não recebeu outro participante. Mantêm-se as pendências de Windows físico, NAT restritivo sem TURN, capacidade com 12 participantes, qualidade sustentada em alta resolução, hospedagem definitiva e recuperação em destino independente. Não foi contratado serviço pago. A assinatura do atualizador não é Authenticode.

## Alvo de 5 a 8 participantes — retorno do usuário

O usuário informou grupos de 5 a 8 pessoas e adiou o teste pelo 5G. O [ensaio de capacidade](evidence/p2p-0.4.0-capacity.json) complementa as provas da release sem alterar código ou instalador.

Cinco clientes tiveram 20 fluxos direcionais de voz decodificados; uma tela animada chegou aos quatro espectadores em 540p e aproximadamente 29 FPS, com teto solicitado de 720p/30 FPS/2 Mb/s por espectador. Essa janela curta passou na recepção de mídia, mas não manteve a resolução solicitada. Oito WebSockets entregaram 504/504 sinais em duas provas sem mídia. Os ensaios de mídia com oito Chromes e uma repetição com cinco não passaram. Na repetição instrumentada, os logs registraram timeout de 500 ms na verificação de autorização; o operador observou carga alta do host nesse momento. Os motivos genéricos das tentativas anteriores não comprovam individualmente a mesma causa. O prazo e as permissões foram preservados; as fontes foram restauradas após instrumentação diagnóstica local.

Esses resultados não homologam oito participantes com voz/tela nem uma qualidade sustentada de 720p/1440p. A validação em computadores separados, Windows físico e redes diferentes permanece pendente. O teste WAN está adiado a pedido do usuário, não aprovado nem considerado falha de conectividade.

## 0.4.1 publicada — autorização e capacidade P2P, 14/11/2026

**Estado atual: correção, capacidade no perfil descrito, CI Linux/Windows, instalador assinado e canal público PASS.** A [prévia 0.4.1](https://github.com/BersaneV/Harmony/releases/tag/v0.4.1) foi publicada a partir de `2ea5c8cfa6eb003d732dbcbe0c4a76ae73bc1f7d`, após a execução completa [43579178430](https://github.com/BersaneV/Harmony/actions/runs/43579178430). O ensaio de 720p/30 FPS [43577516271](https://github.com/BersaneV/Harmony/actions/runs/43577516271) usa `c2375c3c597c57715424aded01c07f0f79a542f0`; os cinco arquivos de produção, testes e harness registrados mantêm hashes idênticos no commit do instalador. A diferença posterior foi a fixture de Caddy e documentação. O [registro sanitizado](evidence/calls-0.4.1-ci.json) identifica os dois commits e os limites; falhas históricas permanecem registradas. Isso não substitui homologação em Windows físico ou redes diferentes.

### Mudanças e regressões

Cada verificação de autorização passou de quatro consultas sequenciais a uma única consulta SQLite com sessão, canal, ACL, mute e ban no mesmo snapshot. As duas pontas de cada sinal continuam verificadas, sem cache e com o mesmo prazo de 500 ms. A regressão com oito sessões SQLite e 150 ms de espera controlada por aquisição passou de 0/8 dentro do prazo para 8/8 em 174 ms; a repetição completou em 193 ms. O negativo com 650 ms manteve o bloqueio em aproximadamente 500 ms. Isso demonstra a redução das aquisições e das esperas acumuladas, sem atribuir exclusivamente às consultas toda a falha observada no Mac. Passaram 40 testes Rust, Clippy, 23 cenários diferenciais SQL e 59 critérios HTTP/WS. Os cenários e hashes atuais estão no [registro local](evidence/calls-0.4.1-local.json).

A engine evita chamadas nativas redundantes quando faixa e parâmetros já correspondem ao estado desejado. Seleciona por emissor o H264 Constrained Baseline negociado `42e01f`, `packetization-mode=1`, somente com geometria e limites compatíveis com até 1280×720, 30 FPS e 14 Mb/s. Altura automática, geometria desconhecida ou perfis superiores usam VP8 quando a API permite a seleção. FPS/bitrate automáticos continuam elegíveis quando seus tetos efetivos cabem no envelope. API ausente, ignorada ou rejeitada mantém a seleção nativa do navegador; não constitui confirmação do codec efetivo.

A troca confirmada para VP8 precede uma ampliação da captura e não antecipa mudanças nos limites anteriores. Se falhar, preserva a qualidade anterior. Um sender que passou a VP8 não tenta voltar a H264. Participantes tardios aguardam a preparação da tela; uma barreira por operação, geração e faixa protege mudanças concorrentes de qualidade, incluindo erro de captura e reconexão. Não há edição de SDP ou da lista negociada de codecs. Revisão independente, 45 testes de engine, 114 testes frontend, typecheck e build passaram. O SHA-256 de `apps/desktop/src/lib/call.ts` usado na prova de oito é `8d3c4e47b05cc4158ce32369fa8b463ec79a42033a03dc6c4ab45e13dade0e7a`.

### Prova de oito participantes com o produto

O ensaio [43577516271](https://github.com/BersaneV/Harmony/actions/runs/43577516271) executou oito processos Chrome no mesmo runner Ubuntu, com API/WS/SQLite e engine reais. Manteve 28 pares de conexão, 56 fluxos direcionais de microfone, uma fonte de vídeo no slot de tela e sete fluxos de áudio da tela. Não usou STUN externo, TURN, LiveKit ou preferência de codec injetada pela fixture. A engine escolheu H264 `42e01f` nas sete saídas do emissor de tela.

O perfil solicitado foi 1280×720, 30 FPS e 4 Mb/s por espectador, com pelo menos 24 FPS médios exibidos. A prova declarou antes de iniciar 30 s fixos de acomodação observada e mais 180 s de medição. Fontes e conexões não foram reiniciadas entre as fases; não houve extensão da espera para alcançar um resultado. Perda de sinalização, autorização ou fontes encerradas reprova nas duas fases. Ao fim da acomodação, todas as fontes precisam decodificar e as dimensões devem ser exatas para iniciar a medição sustentada.

| Fase | Resultado observado |
|---|---|
| Acomodação registrada, 30,0045 s | 36 de 630 amostras de fluxo de áudio ficaram fora do orçamento da fase sustentada; máximo de 5,9876% de reconstrução. Três espectadores começaram em 360p, e o último atingiu 720p na amostra de 17,0236 s. A fase inicial não recebeu PASS de qualidade. |
| Medição sustentada adicional, 180,7825 s | Sete espectadores em 1280×720 nas amostras; médias de 26,7565–29,6949 FPS exibidos, descontando quadros descartados. Nenhum intervalo de áudio reprovou; máximo de 0,7186% de amostras reconstruídas. |
| Continuidade de vídeo | Nenhum intervalo inteiro de amostragem nominal de três segundos ficou sem avanço do vídeo exibido. Esse critério não exclui pausas mais curtas. |
| Moderação | Mute e mudanças de permissão em 52–464 ms; reset de senha em 1.159 ms. Todos passaram no limite de dois segundos do ensaio. |

Cada intervalo dos 56 fluxos de voz e sete de áudio da tela exige progresso RTP e de bytes/pacotes, RMS incremental acima de 0,03, cobertura sem amostras reconstruídas de pelo menos 80% do tempo e no máximo 2% de amostras reconstruídas. Dados ausentes ou contadores regredidos reprovam. Esses orçamentos são critérios explícitos do ensaio; não são garantias acústicas nem limiares definidos pelo W3C. O perfil histórico de 720p/15 FPS exige pelo menos 12 FPS; nenhum desses perfis aprova outro implicitamente.

As entradas são arquivos WAV/Y4M gerados e expostos como dispositivos virtuais. O vídeo é uma câmera falsa enviada no slot de tela; a prova de oito não executa getDisplayMedia. O microfone do emissor e seu áudio de tela usam o mesmo arquivo de tom de 330 Hz. Fontes distintas e captura real de uma aba própria por getDisplayMedia são exercitadas pela suíte separada de três navegadores. Não foram capturados dispositivos ou conteúdo pessoais. Sandbox, perfis próprios, guardas de captura falsa e limpeza permanecem ativos.

Continuam sem validação: oito máquinas Windows físicas, qualidade acústica, captura de monitor/jogo e áudio do sistema com oito pessoas, múltiplas telas/câmeras simultâneas, 1440p ou 60 FPS sustentados, WAN/5G, NAT restritivo, hospedagem externa definitiva gratuita e restauração em host independente. O usuário adiou a prova celular; ela não recebeu PASS nem foi classificada como falha de conectividade.

### Histórico preservado de falhas e controles

As tentativas locais registraram falhas de qualidade e divergência dos relógios do gerador de áudio. Arquivos de captura falsa precisaram de localização permitida pela sandbox de áudio do Chrome no macOS. A troca para fontes virtuais nativas foi uma correção do ambiente de teste, sem captura pessoal nem relaxamento da sandbox. Os resultados reprovados não foram reclassificados.

| Execução e perfil | Evidência preservada |
|---|---|
| [43568286497](https://github.com/BersaneV/Harmony/actions/runs/43568286497), 720p/15 FPS, sem acomodação separada | FAIL de capacidade após as suítes anteriores, inclusive três navegadores, passarem. Oito sessões conectadas por 182,635 s; sete vídeos terminaram em 720p, mas um espectador ficou em 11,898 FPS, abaixo dos 12 exigidos. Nove amostras de fluxo excederam 2% de reconstrução de áudio; máximo 3,861%. Moderação NOT_RUN; nenhum pacote Windows aprovado nessa execução. |
| [43570720246](https://github.com/BersaneV/Harmony/actions/runs/43570720246), repetição manual | FAIL; conexões preservadas por 182,903 s e reconstruções registradas em torno de 9,550 s do início. Mute, PUBLISH e CONNECT em 65–411 ms. O reset foi corretamente rejeitado porque a fixture enviava senha aleatória onde a API exige a senha atual do administrador; corrigida somente a entrada do teste. |
| [43571849320](https://github.com/BersaneV/Harmony/actions/runs/43571849320), acomodação fixa de 30 s | FAIL na fronteira de 30,001 s: algumas telas ainda estavam em 270p–540p. A medição sustentada não começou e a espera não foi prolongada. |
| [43572690856](https://github.com/BersaneV/Harmony/actions/runs/43572690856), cliente anterior, codec nativo, 720p/15 FPS | PASS do gate de capacidade: 182,743 s, todos em 720p, médias de 12,777–14,643 FPS e nenhuma amostra de áudio fora dos orçamentos. Demonstra variabilidade entre execuções; as falhas anteriores não podem ser atribuídas exclusivamente ao codec. |
| [43572691306](https://github.com/BersaneV/Harmony/actions/runs/43572691306), preferência H264 apenas na fixture, 720p/15 FPS | PASS experimental, com médias de 14,979–15,002 FPS. Não certificou a seleção por emissor do produto nem 1440p; a implementação final recebeu a prova própria de 30 FPS descrita acima. |

O harness passou a coletar moderação após a janela conectada mesmo se a qualidade reprovar, sem converter o resultado final em PASS. Os diagnósticos foram divididos em linhas curtas, e o workflow manual de capacidade permite repetir o ensaio sem compilar novamente os parsers de mídia. A acomodação fixa é registrada separadamente; os limiares da fase sustentada não foram reduzidos.

### CI assinado e publicação

A execução assinada [43577513413](https://github.com/BersaneV/Harmony/actions/runs/43577513413) parou antes das regressões integradas e do Windows no teste isolado de Caddy, após 7,042 s sem readiness. O log temporário havia sido apagado, portanto a causa original permanece desconhecida. O PASS do ensaio manual de capacidade não transforma essa execução em sucesso.

A correção altera somente a fixture de Caddy: desabilita instalação de CA e autosave no host, usa prazo monotônico de inicialização com pausa em toda resposta não pronta e preserva diagnóstico limitado. Rotas, asserts e prazo de autorização de 500 ms do produto permanecem iguais. O teste obrigatório com Caddy 2.11.9 real passou localmente em 1,483 s e na repetição independente em 2,032 s. A repetição completa assinada [43579178430](https://github.com/BersaneV/Harmony/actions/runs/43579178430) passou em Linux e Windows no commit `2ea5c8cfa6eb003d732dbcbe0c4a76ae73bc1f7d`.


O CI final repetiu oito processos Chrome, sem override de codec, com 30,0009 s de acomodação registrada e 180,0373 s adicionais em 720p/15 FPS. Todos os sete espectadores mantiveram 1280×720, com médias de 14,9961–15,0024 FPS exibidos e nenhum intervalo de áudio reprovado; máximo de 0,5924% de reconstrução de áudio na janela sustentada. A acomodação teve zero amostras de áudio fora do orçamento e continua RECORDED. Essa repetição é separada da prova de 30 FPS. Os 387 critérios do ensaio passaram. Também passaram 40 testes Rust, Clippy, 59 critérios de protocolo, 54 de RTC com três navegadores, 103 de ACL, 29 de arquivos locais, 51 do worker, seis de sandbox, 30 de descoberta, 34 do diagnóstico e a implantação supervisionada com API/worker, tmpfs privado, backup/restauração em diretório e reinício. Não é restauração operacional em outro host.

No Windows passaram 114 testes frontend, quatro de temas, quatro nativos de política de atualização, 17 de assinatura/versão e nove de instalação/remoção silenciosa. O instalador `Harmony_0.4.1_x64-setup.exe` tem 4.059.851 bytes e SHA-256 `509e30e8781876caa64ec8b36fc37ddb76bf868924717fd44ca6c109b7ab42bf`. A instalação do CI não abre o aplicativo e não prova captura ou substituição de uma versão em uso. A assinatura Ed25519 do atualizador não é Authenticode.

O arquivo baixado foi novamente aprovado nas 17 verificações locais. O canal público ofereceu a 0.4.1 para a 0.4.0, com download HTTPS real e assinatura/versão/digest conferidos; a consulta como 0.4.1 retornou `no_update`. Os probes usam o plugin real com MockRuntime selecionando Windows x64 e não instalam no Mac. Relatórios estão anexados à release.

O piloto temporário foi atualizado para 0.4.1/P2P. Health e metadados públicos responderam 200; os 13 arquivos públicos do frontend, somando 1.204.869 bytes, coincidiram com os hashes do build local. A configuração existente permaneceu com o mesmo hash, e banco/arquivos e backup privado foram preservados. O piloto depende do Mac e do túnel existentes; não é hospedagem externa permanente. Nenhum recurso pago ou entrada de config.toml foi criado nesta correção.
