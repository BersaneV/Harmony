# Backend do Harmony

O binário `harmony-server` usa Rust/Axum e SQLite persistente. `crates/domain` contém modelos e regras puras; `crates/application` define a porta de persistência e o caso de uso de envio; `crates/server` adapta HTTP/WebSocket e LiveKit. `crates/database` concentra conexão/migração SQLite e o bloqueio de manutenção; `crates/storage` fornece arquivos locais privados, com adaptador S3 opcional; `crates/search` mantém a tokenização da busca anterior. Não há fallback para banco em memória ou respostas simuladas.

A implantação padrão reúne API, frontend Web compilado e worker de mídia em uma imagem, sob `scripts/supervise.py`. API e worker continuam processos separados; FFmpeg/ffprobe permanecem em subprocessos isolados. O supervisor testa o sandbox antes de iniciar a API, espera seu healthcheck e inicia o worker; se um processo necessário termina, encerra a instância para reinício pelo supervisor externo. LiveKit continua como serviço de voz/vídeo; Caddy é usado no perfil público. PostgreSQL, Valkey e SeaweedFS não são serviços obrigatórios do perfil atual.

## Execução

Configure o `.env` com o gerador do projeto. Execute `python3 scripts/with-env.py cargo run -p harmony-server` a partir da raiz, com Cargo no PATH. As migrações versionadas são aplicadas no início. Em banco vazio, `HARMONY_BOOTSTRAP_USERNAME` e `HARMONY_BOOTSTRAP_PASSWORD` criam o administrador; em banco existente, não alteram a senha. Remova a senha de bootstrap do ambiente de produção após a inicialização.

`DATABASE_URL` usa `sqlite:./data/harmony.db` por padrão na API; no compose, API e worker compartilham `sqlite:/data/harmony.db` e `HARMONY_STORAGE_DIR=/data/files`. `HARMONY_STORAGE_BACKEND=local` é o padrão. O worker exige `DATABASE_URL` explícita. `HARMONY_PUBLIC_API_URL` contém a origem pública da API, usada nas URLs de arquivos. `HARMONY_JWT_SECRET` é obrigatória, com pelo menos 32 bytes e sem o placeholder do exemplo. `HARMONY_PUBLIC_ORIGIN` é uma lista explícita, separada por vírgulas, que inclui as origens Tauri dos clientes autorizados. Não usar `*`. A API escuta `127.0.0.1:8080` por padrão. `GET /health` verifica acesso ao banco.

`HARMONY_TRUST_PROXY=true` só deve ser configurado quando a API recebe tráfego através de um proxy local confiável que sobrescreve os cabeçalhos encaminhados. O rate limiter considera `X-Forwarded-For` somente com esse sinalizador e um socket de origem loopback. A API não deve ficar exposta diretamente na implantação de produção.

## Garantias implementadas

- Senhas Argon2id, concorrência limitada a duas operações de hash, nomes de login normalizados, cadastro aberto com nome de usuário e senha. Convites opcionais continuam com consumo transacional e expiração; novos cadastros não recebem privilégio administrativo nem associação automática a comunidades.
- Access JWT HS256 de10min; refresh aleatório, somente hash persistido, rotação, detecção de reuso e revogação. Cada operação autenticada reconsulta sessão e usuário. Reset aumenta versão, revoga sessões e desconecta WebSockets. A senha verificada no login é conferida novamente por hash/versão sob lock antes da criação da sessão, cobrindo a corrida com reset.
- Logout reconhece o refresh atual e os tokens consumidos da mesma sessão. O código administrativo de reset é de uso único, expira em15min e só é emitido após reautenticação. Não há recuperação da senha anterior.
- Comunidades, canais text/voice, hierarquia owner/admin/member, convites, amigos e conversas DM/group persistidos. Administrador global não ganha acesso automático ao conteúdo de uma comunidade pela API.
- Envio com idempotência por canal/autor/client_nonce e comparação do payload original. Transações `BEGIN IMMEDIATE` serializam escritores entre API e worker, incluindo incremento de cursor, ACL e commit. Mensagem e evento de outbox são gravados na mesma transação. ACK é retornado após commit.
- `Message.seq` mantém a posição de criação. `event_seq` indica a última alteração. O histórico `after_seq` recupera criações, edições, reações e tombstones; `cursor` é o avanço seguro da página. O cliente deve avançar pelo cursor retornado, respeitar `has_more` e marcar leitura por esse cursor.
- WebSocket recebe token no primeiro frame, nunca na URL. Cada evento enviado e comando recebido revalida a sessão; conteúdo de canal exige ACL corrente. Há recuperação HTTP após reconexão e sinal `resync` quando o buffer se perde. WebSocket é transporte de avisos, não a única cópia das mensagens.
- Busca SQLite FTS5 com lexemas compatíveis com a configuração PostgreSQL `simple` anterior e filtros de autorização, reações idempotentes e leitura monotônica. Exclusão mantém tombstone e impede novo download dos anexos pela API.
- Reserva de upload com cota lógica global e limite de pendências. PUT assinado vincula tamanho/tipo. Finalização copia para chave exclusivamente do servidor e verifica tamanho/conteúdo antes de publicar, prevenindo reescrita através da URL de upload ainda válida. Temporários são limpos após o vencimento em transação de escrita; originais associados a mensagens não são eliminados para liberar espaço.

## Mídia

LiveKit é acessado pelo protocolo oficial Twirp/JSON com JWT emitido no servidor; o aplicativo não retransmite os pacotes de mídia. Configure `LIVEKIT_URL`, `LIVEKIT_API_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. As salas usam `harmony-{channel_id}` e a identidade `{user_id}:{session_id}`. Novos tokens duram60s e a quantidade de participantes usa `HARMONY_MAX_ROOM_PARTICIPANTS` (12 por padrão).

O LiveKit renova os tokens de participantes conectados. Por isso, o TTL inicial de60s **não** limita sozinho a possibilidade de reconexão. Na implantação Caddy, o endpoint interno `GET /api/internal/media-admit` valida a assinatura do token LiveKit, identidade, sessão, ACL, bloqueios e permissão de publicação antes do acesso à sinalização. Ele só atende peer loopback quando o modo de proxy confiável está habilitado. `Authorization` tem precedência; se estiver ausente, usa `X-Livekit-Query-Token`, preenchido pelo proxy a partir da query real. Cabeçalho Authorization malformado falha sem fallback. LiveKit7880 precisa permanecer inacessível externamente.

A remoção/reconciliação de conexões já abertas complementa a admissão. Não prometer revogação instantânea em qualquer caminho de rede sem testar o proxy e impedir acesso direto ao SFU. A ação `mute` restringe publicação de áudio/vídeo e persiste até `unmute`; `remove` desconecta e bloqueia nova admissão por65s. O cliente recebe a política de bitrate, mas o JWT LiveKit não implementa teto numérico de bitrate. Os limites dos encoders e o bloqueio de tráfego na borda fazem parte da operação completa.

## Limites e validação

O limite de armazenamento contabiliza bytes lógicos reservados e prontos, não todo uso físico do disco. Staging, cópia de finalização, SQLite/WAL, logs e backups precisam de espaço adicional. PUTs são transmitidos para disco com limite de bytes e quatro vagas concorrentes; downloads são transmitidos em blocos e suportam Range. URLs GET duram até 60 s, mas cada consumo revalida sessão, ACL e estado do anexo; revogação bloqueia um novo GET mesmo com URL emitida anteriormente. Um fluxo já iniciado pode ter enviado bytes e não permite recolhê-los. Originais usam disposition attachment; derivados autorizados podem ser exibidos inline. Tipos por magic bytes não equivalem a antimalware. Veja [LOCAL-STORAGE.md](LOCAL-STORAGE.md).

SQLite opera com foreign keys, WAL e synchronous FULL. API, worker e CLI retêm lease compartilhado em `<caminho-canônico-do-banco>.lock`; backup, restauração e migração offline exigem lease exclusivo. Pare API e worker para backup consistente de banco e objetos juntos. Não use SQLite antigo do host para modificar o WAL ativo. `scripts/backup.sh` e `scripts/restore.sh` chamam o procedimento offline.

O gerenciamento possui os papéis administrativos owner/admin/member, cargos personalizados e overrides por canal com seis permissões (VIEW, SEND, ATTACH, REACT, CONNECT e PUBLISH). Há validação de IDs da mesma comunidade, precedência definida, filtragem de leitura e fiscalização no servidor. O contrato e a álgebra estão em docs/API.md. Permissões administrativas adicionais e hierarquias de cargos fora desses seis bits não fazem parte desta versão. O registro de outbox e auditoria ainda exige política operacional de retenção. A API não calcula sozinha tráfego real faturado pelo provedor. Não há E2EE, entrega de reset por e-mail, recuperação automática, gravação ou transcrição de chamadas.

Verificações locais:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`: domínio, SQLite, armazenamento, corpus de busca e demais testes sem credenciais.
- `HARMONY_ENV_FILE=/caminho/qa.env python3 scripts/with-env.py cargo test --workspace -- --include-ignored`: inclui corridas login/reset, refresh concorrente e logout após rotação em bancos SQLite descartáveis. Use configuração privada de teste.
- `node scripts/test_local_storage.mjs`: cria sua própria API/SQLite/diretório privado temporários e valida HTTP real. `HARMONY_TEST_WORKER=true` também executa o worker com FFmpeg/ffprobe configurados.
- `HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 HARMONY_ENV_FILE=/caminho/qa.env python3 scripts/with-env.py node scripts/smoke.mjs`: valida HTTP/WS, arquivos privados e LiveKit reais na API configurada. Cria contas e mensagens descartáveis; não apontar para dados de usuários.

Essas verificações não homologam captura de áudio/vídeo no Windows, TURN externo, capacidade de usuários nem recuperação em outra máquina. Consulte o relatório de validação da execução para os resultados efetivamente observados.


## Matriz de autorização

`HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 HARMONY_ENV_FILE=/caminho/qa.env python3 scripts/with-env.py node crates/server/tests/acl.mjs` executa a matriz real REST/WS/arquivos/LiveKit: precedência dos overrides, grants e negações, ausência de bypass do administrador global, IDs cruzados, publicação como espectador, limpeza por exclusão de cargo, PUT com tamanho divergente e imutabilidade do objeto publicado. Os testes SQLite comparam a álgebra do domínio com a view SQL e comprovam a restrição composta contra associação entre comunidades.

As mutações protegidas e mudanças de cargos/overrides usam `BEGIN IMMEDIATE`; a avaliação da ACL ocorre dentro da transação que detém o lock de escrita do banco. Isso preserva a exclusão entre mudança de permissão e operação protegida, com menor paralelismo de escrita que PostgreSQL. A busca mantém filtros de membro e VIEW antes de retornar mensagens.

## Worker de mídia

`crates/media-worker` fornece o binário independente `harmony-media-worker`, executado junto com a API na unidade de implantação padrão. O esquema SQLite mantém a fila com leases/tentativas, registro prévio das chaves de objetos e contabilização inclusiva de cota. A API enfileira de forma transacional após publicar o original e autoriza status/download de derivados. O worker usa FFmpeg/ffprobe em subprocesso isolado, sem carregar parsers dentro da API.

Contrato e operação: [MEDIA-WORKER.md](MEDIA-WORKER.md). Validação real: `scripts/test_worker.mjs`; sandbox independente: `scripts/test_worker_sandbox.py`. Não confundir prova no macOS com validação Linux do Landlock/seccomp, nem com reprodução no Windows.

## Migração e histórico

A implantação anterior usava PostgreSQL e S3/SeaweedFS; `migrations/` e relatórios anteriores permanecem como histórico e origem da migração. `migrations-sqlite/` é o esquema atual. Resultados antigos de PostgreSQL não comprovam o comportamento da implantação SQLite.

`migrate-postgres-to-sqlite.py` importa snapshot somente leitura para banco novo e verifica contagens, digests e referências. `migrate-s3-to-local.py` copia objetos para diretório novo e verifica bytes/hashes. `--snapshot-only` é ensaio, não troca de produção; para uma troca consistente, pare os escritores antigos, preserve banco/bucket antigos e conclua as duas etapas antes de iniciar a nova instância. Instruções em [LOCAL-STORAGE.md](LOCAL-STORAGE.md).

O parser de busca inclui código PostgreSQL sob sua licença própria, com fonte/hash/COPYRIGHT em `crates/search/vendor/`. Não é código AGPL nem altera a licença dos componentes originais. O inventário gerado inclui essa atribuição. A paridade foi exercitada contra o corpus da antiga instância C.UTF-8, sem afirmar equivalência para todo locale/Unicode. O diagnóstico P2P é experimental e separado das chamadas moderadas por LiveKit; veja [P2P-DIAGNOSTICS.md](P2P-DIAGNOSTICS.md).
