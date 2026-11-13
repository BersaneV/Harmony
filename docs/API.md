# Contrato HTTP v1

Prefixo `/api`. JSON UTF-8. IDs UUID como strings, sequências BIGINT como strings decimais, datas UTC ISO8601. Erros: `{ "error": { "code": "...", "message": "..." } }`. Listas em `{ "items": [...] }`. Bearer access_token. Nenhuma credencial em URL, inclusive WebSocket. Payloads desconhecidos rejeitados onde sensível. Permissões sempre no servidor.

## Autenticação

- `GET /health`: `{status:"ok"}` (fora de /api).
- `GET /api/instance`: `{name,registration:"open",max_upload_bytes,max_video_bitrate,media_transport:"p2p"|"livekit",version}`. Bootstrap feito por variáveis de ambiente no primeiro start, nunca por endpoint público.
- `POST /api/auth/login`: `{username,password}` → `{access_token,refresh_token,user}`.
- `POST /api/auth/register`: `{username,password,display_name?,invite_token?}` → sessão como login. Cadastro sem convite é permitido e não concede acesso automático a comunidades nem privilégios administrativos. Nome de exibição ausente usa o login normalizado. Convite explícito é opcional e deve ser válido; quando vinculado a comunidade, adiciona a pessoa como membro na mesma transação.
- `POST /api/auth/refresh`: `{refresh_token}` → sessão rotacionada.
- `POST /api/auth/logout`: `{refresh_token}` → 204.
- `POST /api/auth/reset`: `{token,password}` → 204, revoga sessões.
- `GET /api/me`: User. `PATCH /api/me`: `{display_name?,preferences?}` → User.
- User: `{id,username,display_name,is_admin,disabled,preferences,created_at}`. Preferências JSON limitado, sem execução de CSS/JS.

## Comunidades e conversas

- `GET/POST /api/guilds` body criação `{name}` → Guild `{id,name,owner_id}`.
- `GET /api/guilds/{id}/members` → User com `role` (owner/admin/member).
- `PATCH /api/guilds/{id}/members/{user_id}` `{role:"admin"|"member"}`; `DELETE` remove membro. Dono não removível/rebaixável implicitamente.
- `GET/POST /api/guilds/{id}/channels` body `{name,kind:"text"|"voice"}` → Channel `{id,guild_id,name,kind,last_seq,effective_permissions}`.
- `POST /api/guilds/{id}/invites` `{expires_hours?:24,max_uses?:1}` → `{token,expires_at}`. `POST /api/invites/accept` `{token}` → Guild.
- `GET /api/conversations` → Channel (DM/group, guild_id:null, participants User[]). `POST /api/conversations` `{user_ids:string[],name?:string}` → Channel. DM exige amizade aceita; grupos também.
- `GET /api/users/search?q=` usuários mínimos `{id,username,display_name}`.
- `GET /api/friends` → `{items:[{id,user:User,status:"pending"|"accepted",incoming:boolean}]}`.
- `POST /api/friends` `{username}` → amizade. `POST /api/friends/{id}/accept`, `DELETE /api/friends/{id}` → 204.

## Mensagens

- `GET /api/channels/{id}/messages?before_seq=&after_seq=&limit=50`: `{items:Message[],has_more:boolean,cursor:string}`. `cursor`/`event_seq` representam alterações; `seq` preserva a posição original. `after_seq` recupera também edição/exclusão/reação de mensagens antigas. Ordens crescentes no resultado. before pega últimas anteriores; after recuperação. Tombstones em recuperação.
- `POST /api/channels/{id}/messages` `{client_nonce:UUID,content:string,attachment_ids?:string[]}` → Message. Retry do mesmo nonce/autor/canal não duplica; reutilização com payload diferente →409.
- `PATCH /api/messages/{id}` `{content}` → Message; `DELETE` →204.
- `PUT/DELETE /api/messages/{id}/reactions/{emoji}` →204. Emoji curto codificado na URL.
- `POST /api/channels/{id}/read` `{seq:string}` →204 (nunca acima do último seq).
- `GET /api/search?q=&channel_id=` → `{items:Message[]}` com ACL.
- Message: `{id,channel_id,author:User,content,seq,event_seq,client_nonce,created_at,edited_at:null|string,deleted:boolean,reactions:[{emoji,count,me}],attachments:[{id,name,content_type,size}]}`.
- `GET /api/ws`: upgrade sem token na URL; primeiro frame em até5s `{type:"auth",token:access_token}`. Servidor responde `{type:"ready"}`; eventos `{type:"message.created"|"message.updated"|"message.deleted"|"reaction.updated",channel_id,message?}`. Invalidação ACL e sessão verificada antes do envio, comandos e periodicamente. Eventos são hints: cliente recupera por histórico após reconexão. HTTP é o caminho de comandos e ACK após commit. Presence/typing opcionais `{type:"typing",channel_id}` com ACL e limite. `{type:"resync"}` após perda de buffer.

## Mídia/anexos/admin

- `POST /api/channels/{id}/media-token` → `{token,url,room,max_video_bitrate}`. Somente modo LiveKit (modo P2P retorna503 com orientação de atualizar o cliente). TTL curto, identidade vincula usuário/sessão; só canal voice ou DM/group. `POST /api/channels/{id}/moderate` `{user_id,action:"mute"|"unmute"|"remove"}` →204, exige dono/admin comunidade. Desconexão global em reset/bloqueio.
- `POST /api/channels/{id}/uploads` `{name,size,content_type}` → `{id,url,headers}`; PUT direto do cliente ao storage. `POST /api/uploads/{id}/complete` → metadata após validação do objeto. `GET /api/uploads/{id}/download` → `{url}` com ACL corrente.
- `GET /api/admin/users` → Users. `PATCH /api/admin/users/{id}` `{disabled}` →User. `POST /api/admin/users/{id}/reset` `{password}` (senha atual do admin para reauth) → `{token,expires_at}`. `POST /api/admin/invites` `{expires_hours?,max_uses?}` → código de cadastro.
- `GET /api/admin/audit` → eventos sem segredos. `GET /api/admin/stats` → contagens e limites de configuração.

As respostas opcionais/null devem ser toleradas no cliente. Extensões de produto têm contrato adicional antes de aparecer na UI. Serviços ausentes retornam503 com explicação; nunca simular sucesso.


## Cargos personalizados e permissões por canal

Máscaras decimais serializadas como strings: VIEW=1, SEND=2, ATTACH=4, REACT=8, CONNECT=16 e PUBLISH=32. Bits fora de0–63 são rejeitados. `Channel.effective_permissions` contém a máscara efetiva do usuário. O membro retornado em `/guilds/{id}/members` inclui `role_ids:string[]`; os papéis administrativos `owner/admin/member` continuam separados dos cargos personalizados.

- `GET /api/guilds/{id}/roles` → `{items:Role[]}`, disponível aos membros.
- `POST /api/guilds/{id}/roles` `{name,permissions:string}` → Role; no máximo50 por comunidade.
- `PATCH /api/roles/{id}` `{name?,permissions?}` → Role.
- `DELETE /api/roles/{id}` →204; remove também atribuições e overrides daquele cargo.
- `PUT /api/guilds/{id}/members/{user_id}/roles/{role_id}` →204; atribuição idempotente.
- `DELETE` na mesma rota →204; remove atribuição.
- `GET /api/channels/{id}/permissions` → `{items:[{role_id:null|string,allow:string,deny:string}]}`, disponível a owner/admin da comunidade.
- `PUT /api/channels/{id}/permissions` `{role_id:null|string,allow:string,deny:string}` →204. `role_id:null` representa todos os membros. `allow=0,deny=0` remove o override; o mesmo bit não pode constar em allow e deny do mesmo override. IDs de outro canal/comunidade são rejeitados.
- Role: `{id,guild_id,name,permissions:string}`. Todas as escritas exigem owner/admin da comunidade; administrador global não recebe bypass implícito.

Álgebra: owner/admin da comunidade têm63. Para member, a base inicial é63 e recebe OR das permissões base dos cargos; aplica-se `(base & ~everyoneDeny) | everyoneAllow`, depois `(resultado & ~OR(roleDeny)) | OR(roleAllow)`. Permissões permitidas vencem negações entre cargos personalizados. Se VIEW ficar negado, a máscara inteira torna-se0. Como a base padrão é63, os overrides de canal são o mecanismo de restrição efetivo desta versão; a permissão base de um cargo não reduz a base herdada.

VIEW filtra canais, histórico, pesquisa, download e eventos WS. SEND rege criação/edição e digitando. ATTACH é exigido na reserva/finalização e ao associar anexos a uma mensagem. REACT rege adicionar/remover reações. A exclusão da própria mensagem continua disponível com VIEW. CONNECT permite entrar em chamada; PUBLISH permite publicar tracks, sem conceder moderação. DM/group mantém máscara63 para seus participantes.

Mudanças de cargos/overrides emitem `{type:"permissions.updated",guild_id}` após commit, somente para membros da comunidade. O cliente deve refazer consultas e remover conteúdo que perdeu VIEW. O servidor não depende desse evento para autorizar requisições. A mídia revalida CONNECT na admissão/reconciliação; PUBLISH revogado interrompe publicação, preservando recepção. A restauração de PUBLISH atualiza a permissão do participante existente, respeitando mute administrativo.

## Processamento assíncrono de anexos

`Message.attachments` inclui `media_status?: "queued"|"processing"|"ready"|"unsupported"|"failed"`. O original continua disponível quando a prévia falha.

- `GET /uploads/{id}/media`: `{status,metadata:null|{kind:"image"|"video"|"audio",format,width?,height?,duration_seconds?,has_audio},derivatives:[{kind:"thumbnail"|"faststart",content_type,size,width?,height?}],error_code:null|string}`. Polling de 2–3s durante queued/processing; sem evento WS obrigatório nessa versão.
- `GET /uploads/{id}/derivatives/{thumbnail|faststart}`: `{url,expires_in:60,content_type,size}`; 404 se derivado indisponível. JPEG e MP4 são privados. Revalida sessão, VIEW atual e vínculo com mensagem não excluída; anexo sem mensagem é exclusivo do autor.
- `quota_wait` significa espera por espaço para a reserva dos derivados. Falha da prévia não invalida o original. Metadados não incluem tags arbitrárias do arquivo.
- `admin/stats.storage_bytes` inclui originais, reservas e derivados, segundo `harmony_storage_used()`.

Pipeline, limites, estados, recuperação e sandbox: [MEDIA-WORKER.md](MEDIA-WORKER.md).


## Chamadas reais P2P

Contrato separado do diagnóstico de120s. Configuração/limites e interpretação da moderação estão em [P2P-CALLS.md](P2P-CALLS.md).

- `GET /api/channels/{id}/call` → `{transport,max_participants,max_video_bitrate,ice_servers,participants}`; exige sessão válida, VIEW/CONNECT, canal voice/dm/group e ausência de ban vigente.
- `GET /api/calls` → WebSocket. Primeiro frame em até5s: `{type:"auth",token,channel_id}`. Resposta `{type:"ready",peer_id,channel_id,participants,max_participants,max_video_bitrate,ice_servers}`; somente quando o modo da instância é P2P.
- Participante: `{peer_id,user_id,display_name,can_publish,media:{microphone,camera,screen,screen_audio}}`. A lista inclui o próprio usuário. `peer_id` é atribuído pelo servidor e muda após reentrada.
- Servidor `{type:"roster",participants}` substitui a lista autorizada. Ausência remove a conexão; `can_publish:false` impede publicação e reprodução de mídia desse remetente no cliente oficial.
- Cliente `{type:"signal",to,data}`; servidor encaminha `{type:"signal",from,data}` somente entre participantes atuais do mesmo canal. `data` contém exatamente um campo: `description:{type:"offer"|"answer",sdp}`, `candidate:RTCIceCandidateInit|null` ou `receive:{screen_height:0|144|240|360|480|720|1080|1440|2160}`. `from` não é aceito do cliente. Sinalização para quem já saiu é descartada.
- Cliente `{type:"media",microphone,camera,screen,screen_audio}` atualiza flags, limitadas por PUBLISH/mute. `screen_audio` exige `screen`.
- Cliente `{type:"ping"}` a cada10s; servidor `{type:"pong"}`. Inatividade de35s encerra o socket.
- Cliente `{type:"reauth",token}` aceita somente token atual da mesma conta/sessão e responde `{type:"authenticated"}`; falha encerra.
- Servidor `{type:"closed",reason,code}` precede fechamento quando possível. Sem log/persistência de SDP, ICE ou tokens.

Frames até64KiB, SDP até48KiB, candidatos até4096bytes; fila de64 frames por destinatário, até384 frames/512KiB/48 descrições por janela de10s por conexão. Uma conexão por usuário, limite configurado por canal e256 na instância. Consumidor lento é removido sem bloquear os demais. A autorização é revalidada na entrada, sinalização, publicação e watchdog; a API de moderação existente atua no transporte escolhido. Não há gravação de mídia.
