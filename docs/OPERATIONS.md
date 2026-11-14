# Operar o Harmony 0.4.1

O perfil P2P usa `harmony` (API, frontend e worker em processos separados) e, para entrada pública, `caddy`. O `livekit` é opcional, iniciado somente com `--profile sfu`. SQLite e os arquivos privados ficam no volume `data`. O aplicativo Windows é cliente e não instala esses serviços.

Servidor: Linux dedicado com Docker Engine/Compose, disco local e Landlock ABI 3 (kernel 6.2+) com seccomp. O Compose usa rede do host; não é homologado no Docker Desktop de macOS/Windows. O supervisor verifica o sandbox antes de abrir a API. Sem suporte, a unidade falha e não processa arquivos sem isolamento.

## Instalação nova

```sh
python3 scripts/configure.py
docker compose up -d --build
```

A API serve o frontend em `http://127.0.0.1:8080`. O gerador cria `.env` e `.local/deploy/` privados, recusa sobrescrita e não contata provedores. A senha inicial está em `HARMONY_BOOTSTRAP_PASSWORD`; só é usada para criar a primeira conta. Não envie `.env` aos participantes. O cadastro é aberto: os participantes criam nome de usuário e senha, sem convite de cadastro. Contas novas não são administradoras nem entram automaticamente em comunidades. Cada comunidade controla a entrada por seus próprios convites.

Para desenvolvimento nativo, compile o frontend e os binários e use `scripts/with-env.py`. `HARMONY_ENV_FILE` seleciona uma configuração isolada; variáveis já definidas no ambiente prevalecem. O banco e storage nativos usam os caminhos absolutos da configuração. No Compose, os caminhos são sobrescritos por `/data/harmony.db`, `/data/files` e `/srv/harmony`.

## Endereço público

Em instalação nova, use `python3 scripts/configure.py --domain seu-dominio.example`. No modo P2P, somente `app` deve apontar ao IP do host; basta HTTPS/WSS, sem portas de mídia no servidor. STUN e a mídia direta usam a conectividade dos participantes. Depois de conferir DNS, firewall e elegibilidade gratuita, execute `docker compose --profile public up -d --build`. Não há subdomínio de arquivos: o gateway autorizado usa `/api/files` na origem da aplicação. Caddy é compilado com o módulo L4 fixado; o binário comum não substitui esse build.

| Porta externa | Função |
|---|---|
| TCP 80 | ACME/renovação |
| TCP 443 | HTTPS/WSS da aplicação e sinalização das chamadas |
| UDP 7882, somente LiveKit | ICE/WebRTC |
| TCP 7881, somente LiveKit | ICE/TCP de contingência |
| UDP 3478, somente LiveKit | TURN/UDP |

Para LiveKit em instalação nova, use `--media-transport livekit` no gerador e `docker compose --profile public --profile sfu up -d --build`. Nesse modo, aponte também `media` e `turn` ao host; o Caddy usa SNI na porta443 para mídia e TURN/TLS. Não basta trocar a variável: o proxy e os nomes DNS precisam corresponder ao modo.

Bloqueie acesso externo a 8080, 7880, 5349, 18081, 18082 e 2019. API e sinalização privada escutam em loopback. TURN 5349 só aceita PROXYv2 do proxy local confiável. O gateway de mídia revalida sessão e ACL em cada conexão/reconexão; chamadas ativas são reconciliadas periodicamente. Health HTTP não comprova conectividade WebRTC.

Arquivos permanecem privados: a API revalida assinatura, sessão e ACL no início de cada transferência. O limite de corpo `/api/files/*` do Caddy acompanha `HARMONY_MAX_UPLOAD_BYTES`; se mudar esse valor, atualize também o `max_size` gerado. Transferências já abertas não são interrompidas retroativamente por revogação.

Em 14/11/2026, o piloto foi migrado para **https://harmony.go.altare.global**, na Altare Always Free. API, frontend, worker, SQLite, arquivos e gateway estão no mesmo host externo, sem serviços locais necessários. O túnel temporário do Mac foi desligado. O perfil nativo e suas diferenças de isolamento/temporários em relação ao Compose estão em [HOSTING.md](HOSTING.md); a gratuidade atual não constitui SLA nem garantia de permanência das políticas do provedor.

## Recursos e limites

Os limites Compose são tetos, não consumo medido: Harmony 1536 MiB/2 CPUs/128 processos; LiveKit 2 GiB; Caddy 256 MiB. O worker continua separado da API, usa tmpfs de 128 MiB e subprocessos com limites adicionais. Veja [worker](MEDIA-WORKER.md).

O SQLite usa outro tmpfs privado de 128 MiB em `/tmp/harmony-sqlite`, indicado por `SQLITE_TMPDIR`, para migrações e operações que exigem arquivos temporários. Ambos os tmpfs pertencem ao UID/GID 10001 e têm modo 0700; seu consumo entra no limite de memória do contêiner. O restante do filesystem continua somente leitura, e os parsers não recebem acesso à área temporária do banco. Esses diretórios não contêm os dados persistentes do backup. Uma operação que exceda a capacidade temporária falha; dimensione esse teto conforme o banco real, sem remover o limite geral de memória.

`HARMONY_MAX_UPLOAD_BYTES`, `HARMONY_STORAGE_QUOTA_BYTES`, `HARMONY_MAX_VIDEO_BITRATE` e `HARMONY_MAX_ROOM_PARTICIPANTS` limitam admissão lógica. Banco, logs, rede, backups e armazenamento físico também exigem monitoramento. Nenhum script cria VPS, exige cartão, contrata domínio ou ativa upgrade. Cota lógica e bitrate do encoder não são bloqueios de cobrança de um provedor.

## Migrar PostgreSQL/S3 existentes

Não execute o novo gerador sobre `.env` antigo nem aponte o servidor SQLite para PostgreSQL. Preserve a implantação e faça ensaio em destino novo. Siga [migração do banco](EMBEDDED-DATABASE.md) e [migração dos objetos](LOCAL-STORAGE.md). `--snapshot-only` não autoriza corte: um snapshot obtido com escritores ativos não inclui as mudanças posteriores. O corte definitivo exige parar os escritores, verificar banco e objetos e só então admitir tráfego. Rollback após novas escritas requer reconciliação.

## Backup offline verificado

```sh
sh scripts/backup.sh /caminho/privado/backup-novo
```

A rotina para Harmony e os serviços opcionais existentes, copia o volume parado, cria snapshot SQLite e manifesto SHA-256 dos objetos/configuração, verifica integridade/FKs/hashes e religa somente os serviços antes ativos. API e worker usam lease compartilhado; manutenção exige lock exclusivo. Não execute escritores externos durante o backup e não compartilhe SQLite por NFS/SMB.

O diretório contém credenciais. Permissões privadas não substituem criptografia e um backup no mesmo disco não protege contra perda do host. Se `RESTIC_REPOSITORY` e `RESTIC_PASSWORD_FILE` apontarem a um destino previamente configurado, a rotina também executa `restic backup` e `restic check`. Não cria conta ou repositório pago. Não há exclusão automática de snapshots.

```sh
sh scripts/restore.sh /caminho/backup /caminho/instancia-nova
```

A restauração recusa destino existente, verifica o manifesto e cria `data/`, `.env` e `.local/deploy/`. Não inicia serviços nem substitui volumes. O `.env` é preservado literalmente: no modo nativo, ajuste `DATABASE_URL`, `HARMONY_STORAGE_DIR` e `HARMONY_WEB_DIR` para os novos caminhos antes de iniciar.

Para restaurar no Compose, use um checkout da mesma versão, copie a configuração restaurada mantendo permissão 0600 e escolha um nome de projeto novo. Crie os containers parados com `docker compose -p harmony-restaurado create harmony`. Importe `data/` em `harmony-restaurado_data`, ajustando dono para UID/GID 10001 e mantendo a instância anterior intacta. O volume deve estar vazio. Não inicie dois projetos simultaneamente nas mesmas portas; pare a instância antiga somente na janela de corte. Confirme login, busca, anexos, ACL e processamento antes de abrir o proxy público. Uma restauração em diretório local não comprova essa operação Docker; o CI e a validação operacional precisam registrar separadamente o ensaio realizado.

## Chamadas reais e diagnóstico P2P

Para migrar uma instância 0.3 existente, faça backup e atualize servidor e clientes juntos. Finalize as chamadas LiveKit e pare o serviço SFU durante o corte para P2P; reiniciar somente a API não é um procedimento de encerramento das sessões no SFU. Defina uma única entrada `HARMONY_MEDIA_TRANSPORT=p2p` no `.env` e `HARMONY_CALL_STUN_URLS=stun:stun.l.google.com:19302` (ou STUN próprio). O gerador não sobrescreve configurações antigas. Não execute dois modos no mesmo canal; a escolha é por instância. Preserve a configuração LiveKit para rollback explícito; não altere banco/arquivos. No modo P2P, perder a sinalização ao reiniciar a API encerra a chamada nos clientes oficiais.

O máximo configurável em P2P é12 participantes (padrão12), com até256 conexões na instância; isso é limite de admissão, não prova de capacidade. O bitrate0,5–32Mb/s é por destinatário. Sem TURN contratado, redes que impedem conexão direta mostram erro; não há fallback pago.

### Diagnóstico separado

`HARMONY_P2P_DIAGNOSTICS=true` habilita o painel temporário. `HARMONY_P2P_STUN_URLS` aceita servidores STUN explícitos; fica vazio por padrão. Não há contratação de TURN. Dois participantes autorizados no mesmo canal podem medir RTT e vídeo sintético por até 120 segundos, sem câmera/microfone/tela. Veja [procedimento e limites](P2P-DIAGNOSTICS.md). As chamadas normais são independentes desse diagnóstico e usam `HARMONY_MEDIA_TRANSPORT=p2p` por padrão. Veja [chamadas reais](P2P-CALLS.md). O painel de diagnóstico continua no cliente LiveKit; o cliente P2P mostra estatísticas da própria chamada.

## Windows e atualização

`npm run desktop:build -- --bundles nsis` gera o instalador. O workflow em repositório público usa runners padrão e não usa armazenamento de artifacts/caches. `package=true` executa os gates e cria uma release assinada em rascunho; publicar o rascunho e o feed é uma ação posterior verificada.

O updater Ed25519 está ativo desde 0.2.0, vincula assinatura à versão e recusa downgrade/adulteração. Instalação exige ação do usuário. Isso não é Authenticode. A chave privada pertence ao mantenedor, fora do Git, com backup criptografado próprio; não faz parte do backup de uma instância. Build, assinatura e instalação em runner não comprovam captura/áudio/desempenho no computador de um participante. Consulte [atualizações](UPDATES.md) e [validação](VALIDATION.md).
