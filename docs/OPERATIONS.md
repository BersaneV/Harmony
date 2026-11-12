# Operar o Harmony 0.3.0

O perfil simplificado usa três serviços: `harmony` (API, frontend e worker em processos separados), `livekit` (voz/vídeo) e `caddy` (entrada pública). SQLite e os arquivos privados ficam no volume `data`. O aplicativo Windows é cliente e não instala esses serviços.

Servidor: Linux dedicado com Docker Engine/Compose, disco local e Landlock ABI 3 (kernel 6.2+) com seccomp. O Compose usa rede do host; não é homologado no Docker Desktop de macOS/Windows. O supervisor verifica o sandbox antes de abrir a API. Sem suporte, a unidade falha e não processa arquivos sem isolamento.

## Instalação nova

```sh
python3 scripts/configure.py
docker compose up -d --build
```

A API serve o frontend em `http://127.0.0.1:8080`. O gerador cria `.env` e `.local/deploy/` privados, recusa sobrescrita e não contata provedores. A senha inicial está em `HARMONY_BOOTSTRAP_PASSWORD`; só é usada para criar a primeira conta. Não envie `.env` aos participantes. O cadastro é aberto: os participantes criam nome de usuário e senha, sem convite de cadastro. Contas novas não são administradoras. Convites de comunidade continuam opcionais para integrar novos membros a uma comunidade existente.

Para desenvolvimento nativo, compile o frontend e os binários e use `scripts/with-env.py`. `HARMONY_ENV_FILE` seleciona uma configuração isolada; variáveis já definidas no ambiente prevalecem. O banco e storage nativos usam os caminhos absolutos da configuração. No Compose, os caminhos são sobrescritos por `/data/harmony.db`, `/data/files` e `/srv/harmony`.

## Endereço público

Em instalação nova, use `python3 scripts/configure.py --domain seu-dominio.example`. Os nomes `app`, `media` e `turn` devem apontar ao IP do host. Depois de conferir DNS, firewall e elegibilidade gratuita, execute `docker compose --profile public up -d --build`. Não há subdomínio de arquivos: o gateway autorizado usa `/api/files` na origem da aplicação. Caddy é compilado com o módulo L4 fixado; o binário comum não substitui esse build.

| Porta externa | Função |
|---|---|
| TCP 80 | ACME/renovação |
| TCP 443 | HTTPS/WSS da aplicação, sinalização de mídia e TURN/TLS por SNI |
| UDP 7882 | ICE/WebRTC |
| TCP 7881 | ICE/TCP de contingência |
| UDP 3478 | TURN/UDP |

Bloqueie acesso externo a 8080, 7880, 5349, 18081, 18082 e 2019. API e sinalização privada escutam em loopback. TURN 5349 só aceita PROXYv2 do proxy local confiável. O gateway de mídia revalida sessão e ACL em cada conexão/reconexão; chamadas ativas são reconciliadas periodicamente. Health HTTP não comprova conectividade WebRTC.

Arquivos permanecem privados: a API revalida assinatura, sessão e ACL no início de cada transferência. O limite de corpo `/api/files/*` do Caddy acompanha `HARMONY_MAX_UPLOAD_BYTES`; se mudar esse valor, atualize também o `max_size` gerado. Transferências já abertas não são interrompidas retroativamente por revogação.

Nenhuma hospedagem permanente está validada. O túnel gratuito temporário do ensaio móvel depende do computador de desenvolvimento e não hospeda o Harmony. Não equivale à implantação externa solicitada.

## Recursos e limites

Os limites Compose são tetos, não consumo medido: Harmony 1536 MiB/2 CPUs/128 processos; LiveKit 2 GiB; Caddy 256 MiB. O worker continua separado da API, usa tmpfs de 128 MiB e subprocessos com limites adicionais. Veja [worker](MEDIA-WORKER.md).

`HARMONY_MAX_UPLOAD_BYTES`, `HARMONY_STORAGE_QUOTA_BYTES`, `HARMONY_MAX_VIDEO_BITRATE` e `HARMONY_MAX_ROOM_PARTICIPANTS` limitam admissão lógica. Banco, logs, rede, backups e armazenamento físico também exigem monitoramento. Nenhum script cria VPS, exige cartão, contrata domínio ou ativa upgrade. Cota lógica e bitrate do encoder não são bloqueios de cobrança de um provedor.

## Migrar PostgreSQL/S3 existentes

Não execute o novo gerador sobre `.env` antigo nem aponte o servidor SQLite para PostgreSQL. Preserve a implantação e faça ensaio em destino novo. Siga [migração do banco](EMBEDDED-DATABASE.md) e [migração dos objetos](LOCAL-STORAGE.md). `--snapshot-only` não autoriza corte: um snapshot obtido com escritores ativos não inclui as mudanças posteriores. O corte definitivo exige parar os escritores, verificar banco e objetos e só então admitir tráfego. Rollback após novas escritas requer reconciliação.

## Backup offline verificado

```sh
sh scripts/backup.sh /caminho/privado/backup-novo
```

A rotina para os três serviços, copia o volume parado, cria snapshot SQLite e manifesto SHA-256 dos objetos/configuração, verifica integridade/FKs/hashes e religa somente os serviços antes ativos. API e worker usam lease compartilhado; manutenção exige lock exclusivo. Não execute escritores externos durante o backup e não compartilhe SQLite por NFS/SMB.

O diretório contém credenciais. Permissões privadas não substituem criptografia e um backup no mesmo disco não protege contra perda do host. Se `RESTIC_REPOSITORY` e `RESTIC_PASSWORD_FILE` apontarem a um destino previamente configurado, a rotina também executa `restic backup` e `restic check`. Não cria conta ou repositório pago. Não há exclusão automática de snapshots.

```sh
sh scripts/restore.sh /caminho/backup /caminho/instancia-nova
```

A restauração recusa destino existente, verifica o manifesto e cria `data/`, `.env` e `.local/deploy/`. Não inicia serviços nem substitui volumes. O `.env` é preservado literalmente: no modo nativo, ajuste `DATABASE_URL`, `HARMONY_STORAGE_DIR` e `HARMONY_WEB_DIR` para os novos caminhos antes de iniciar.

Para restaurar no Compose, use um checkout da mesma versão, copie a configuração restaurada mantendo permissão 0600 e escolha um nome de projeto novo. Crie os containers parados com `docker compose -p harmony-restaurado create harmony`. Importe `data/` em `harmony-restaurado_data`, ajustando dono para UID/GID 10001 e mantendo a instância anterior intacta. O volume deve estar vazio. Não inicie dois projetos simultaneamente nas mesmas portas; pare a instância antiga somente na janela de corte. Confirme login, busca, anexos, ACL e processamento antes de abrir o proxy público. Uma restauração em diretório local não comprova essa operação Docker; o CI e a validação operacional precisam registrar separadamente o ensaio realizado.

## Diagnóstico P2P

`HARMONY_P2P_DIAGNOSTICS=true` habilita o painel temporário. `HARMONY_P2P_STUN_URLS` aceita servidores STUN explícitos; fica vazio por padrão. Não há contratação de TURN. Dois participantes autorizados no mesmo canal podem medir RTT e vídeo sintético por até 120 segundos, sem câmera/microfone/tela. Veja [procedimento e limites](P2P-DIAGNOSTICS.md). Chamadas normais continuam usando LiveKit.

## Windows e atualização

`npm run desktop:build -- --bundles nsis` gera o instalador. O workflow em repositório público usa runners padrão e não usa armazenamento de artifacts/caches. `package=true` executa os gates e cria uma release assinada em rascunho; publicar o rascunho e o feed é uma ação posterior verificada.

O updater Ed25519 está ativo desde 0.2.0, vincula assinatura à versão e recusa downgrade/adulteração. Instalação exige ação do usuário. Isso não é Authenticode. A chave privada pertence ao mantenedor, fora do Git, com backup criptografado próprio; não faz parte do backup de uma instância. Build, assinatura e instalação em runner não comprovam captura/áudio/desempenho no computador de um participante. Consulte [atualizações](UPDATES.md) e [validação](VALIDATION.md).
