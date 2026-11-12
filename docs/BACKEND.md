# Backend do Harmony

O binário `harmony-server` usa Rust/Axum e PostgreSQL. `crates/domain` contém modelos e regras puras; `crates/application` define a porta de persistência e o caso de uso de envio; `crates/server` adapta HTTP, WebSocket, PostgreSQL, S3 e LiveKit. O banco é obrigatório: não há fallback para memória ou respostas simuladas.

## Execução

Configure o `.env` com o gerador do projeto. Execute `python3 scripts/with-env.py cargo run -p harmony-server` a partir da raiz, com Cargo no PATH. As migrações versionadas são aplicadas no início. Em banco vazio, `HARMONY_BOOTSTRAP_USERNAME` e `HARMONY_BOOTSTRAP_PASSWORD` criam o administrador; em banco existente, não alteram a senha. Remova a senha de bootstrap do ambiente de produção após a inicialização.

`DATABASE_URL` e `HARMONY_JWT_SECRET` são obrigatórias. O segredo JWT precisa ter pelo menos32 bytes e não pode usar o placeholder do exemplo. `HARMONY_PUBLIC_ORIGIN` é uma lista explícita, separada por vírgulas, que inclui as origens Tauri dos clientes autorizados. Não usar `*`. A API escuta `127.0.0.1:8080` por padrão. `GET /health` verifica acesso ao banco.

`HARMONY_TRUST_PROXY=true` só deve ser configurado quando a API recebe tráfego através de um proxy local confiável que sobrescreve os cabeçalhos encaminhados. O rate limiter considera `X-Forwarded-For` somente com esse sinalizador e um socket de origem loopback. A API não deve ficar exposta diretamente na implantação de produção.

## Garantias implementadas

- Senhas Argon2id, concorrência limitada a duas operações de hash, nomes de login normalizados, cadastro por convite com consumo transacional e expiração.
- Access JWT HS256 de10min; refresh aleatório, somente hash persistido, rotação, detecção de reuso e revogação. Cada operação autenticada reconsulta sessão e usuário. Reset aumenta versão, revoga sessões e desconecta WebSockets. A senha verificada no login é conferida novamente por hash/versão sob lock antes da criação da sessão, cobrindo a corrida com reset.
- Logout reconhece o refresh atual e os tokens consumidos da mesma sessão. O código administrativo de reset é de uso único, expira em15min e só é emitido após reautenticação. Não há recuperação da senha anterior.
- Comunidades, canais text/voice, hierarquia owner/admin/member, convites, amigos e conversas DM/group persistidos. Administrador global não ganha acesso automático ao conteúdo de uma comunidade pela API.
- Envio com idempotência por canal/autor/client_nonce e comparação do payload original. Lock da conversa serializa incremento de cursor e commit. Mensagem e evento de outbox são gravados na mesma transação. ACK é retornado após commit.
- `Message.seq` mantém a posição de criação. `event_seq` indica a última alteração. O histórico `after_seq` recupera criações, edições, reações e tombstones; `cursor` é o avanço seguro da página. O cliente deve avançar pelo cursor retornado, respeitar `has_more` e marcar leitura por esse cursor.
- WebSocket recebe token no primeiro frame, nunca na URL. Cada evento enviado e comando recebido revalida a sessão; conteúdo de canal exige ACL corrente. Há recuperação HTTP após reconexão e sinal `resync` quando o buffer se perde. WebSocket é transporte de avisos, não a única cópia das mensagens.
- Busca PostgreSQL FTS com filtros de autorização, reações idempotentes e leitura monotônica. Exclusão mantém tombstone e impede novo download dos anexos pela API.
- Reserva de upload com cota lógica global e limite de pendências. PUT assinado vincula tamanho/tipo. Finalização copia para chave exclusivamente do servidor e verifica tamanho/conteúdo antes de publicar, prevenindo reescrita através da URL de upload ainda válida. Temporários são limpos após o vencimento sob lock de linha; originais associados a mensagens não são eliminados para liberar espaço.

## Mídia

LiveKit é acessado pelo protocolo oficial Twirp/JSON com JWT emitido no servidor; o aplicativo não retransmite os pacotes de mídia. Configure `LIVEKIT_URL`, `LIVEKIT_API_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. As salas usam `harmony-{channel_id}` e a identidade `{user_id}:{session_id}`. Novos tokens duram60s e a quantidade de participantes usa `HARMONY_MAX_ROOM_PARTICIPANTS` (12 por padrão).

O LiveKit renova os tokens de participantes conectados. Por isso, o TTL inicial de60s **não** limita sozinho a possibilidade de reconexão. Na implantação Caddy, o endpoint interno `GET /api/internal/media-admit` valida a assinatura do token LiveKit, identidade, sessão, ACL, bloqueios e permissão de publicação antes do acesso à sinalização. Ele só atende peer loopback quando o modo de proxy confiável está habilitado. `Authorization` tem precedência; se estiver ausente, usa `X-Livekit-Query-Token`, preenchido pelo proxy a partir da query real. Cabeçalho Authorization malformado falha sem fallback. LiveKit7880 precisa permanecer inacessível externamente.

A remoção/reconciliação de conexões já abertas complementa a admissão. Não prometer revogação instantânea em qualquer caminho de rede sem testar o proxy e impedir acesso direto ao SFU. A ação `mute` restringe publicação de áudio/vídeo e persiste até `unmute`; `remove` desconecta e bloqueia nova admissão por65s. O cliente recebe a política de bitrate, mas o JWT LiveKit não implementa teto numérico de bitrate. Os limites dos encoders e o bloqueio de tráfego na borda fazem parte da operação completa.

## Limites e validação

O limite de armazenamento contabiliza bytes lógicos reservados e prontos, não todo uso físico do disco. Cópia temporária de finalização, banco, logs, volumes SeaweedFS e derivados consomem espaço adicional; a proteção de disco do host é indispensável. Assinaturas GET têm60s e permanecem válidas até expirar mesmo após revogação de ACL. Tipos por magic bytes não equivalem a antimalware. Downloads usam disposition attachment; processamento multimídia deve rodar no worker isolado.

O gerenciamento possui os papéis administrativos owner/admin/member, cargos personalizados e overrides por canal com seis permissões (VIEW, SEND, ATTACH, REACT, CONNECT e PUBLISH). Há validação de IDs da mesma comunidade, precedência definida, filtragem de leitura e fiscalização no servidor. O contrato e a álgebra estão em docs/API.md. Permissões administrativas adicionais e hierarquias de cargos fora desses seis bits não fazem parte desta versão. O registro de outbox e auditoria ainda exige política operacional de retenção. A API não calcula sozinha tráfego real faturado pelo provedor. Não há E2EE, entrega de reset por e-mail, recuperação automática, gravação ou transcrição de chamadas.

Verificações locais:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `python3 scripts/with-env.py cargo test --workspace -- --include-ignored`: inclui bancos PostgreSQL descartáveis para as corridas login/reset, refresh concorrente e logout após rotação. Exige permissão de criação de banco; não usar credenciais de produção.
- `HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 python3 scripts/with-env.py node scripts/smoke.mjs`: valida as rotas HTTP/WS contra PostgreSQL, S3 e LiveKit reais. Cria contas e mensagens descartáveis no banco configurado.

Essas verificações não homologam captura de áudio/vídeo no Windows, TURN externo, capacidade de usuários nem recuperação em outra máquina. Consulte o relatório de validação da execução para os resultados efetivamente observados.


## Matriz de autorização

`HARMONY_TEST_STORAGE=1 HARMONY_TEST_MEDIA=1 python3 scripts/with-env.py node crates/server/tests/acl.mjs` executa a matriz real REST/WS/S3/LiveKit: precedência dos overrides, grants e negações, ausência de bypass do administrador global, IDs cruzados, publicação como espectador, limpeza por exclusão de cargo, PUT com tamanho divergente e imutabilidade do objeto publicado. Os testes PostgreSQL também comparam a álgebra do domínio com a função SQL e comprovam a restrição composta contra associação entre comunidades.

As mutações protegidas mantêm lock compartilhado da ACL da comunidade durante a transação; mudanças de cargos/overrides usam lock exclusivo. Locks de sequência de mensagem não alteram as chaves do canal e permanecem compatíveis com a verificação das referências dos overrides.
