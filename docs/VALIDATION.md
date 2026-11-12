# Validação da versão de desenvolvimento

Data: 12/11/2026. A implementação está na `main`. Esta página distingue código entregue, provas executadas e aceite operacional. Os testes locais usam dados descartáveis; senhas, tokens, bancos e pacotes proprietários analisados não estão no Git.

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
