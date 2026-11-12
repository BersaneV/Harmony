# Contrato HTTP v1

Prefixo `/api`. JSON UTF-8. IDs UUID como strings, sequências BIGINT como strings decimais, datas UTC ISO8601. Erros: `{ "error": { "code": "...", "message": "..." } }`. Listas em `{ "items": [...] }`. Bearer access_token. Nenhuma credencial em URL, inclusive WebSocket. Payloads desconhecidos rejeitados onde sensível. Permissões sempre no servidor.

## Autenticação

- `GET /health`: `{status:"ok"}` (fora de /api).
- `GET /api/instance`: `{name,registration:"invite",max_upload_bytes,max_video_bitrate,version}`. Bootstrap feito por variáveis de ambiente no primeiro start, nunca por endpoint público.
- `POST /api/auth/login`: `{username,password}` → `{access_token,refresh_token,user}`.
- `POST /api/auth/register`: `{username,display_name,password,invite_token}` → sessão como login.
- `POST /api/auth/refresh`: `{refresh_token}` → sessão rotacionada.
- `POST /api/auth/logout`: `{refresh_token}` → 204.
- `POST /api/auth/reset`: `{token,password}` → 204, revoga sessões.
- `GET /api/me`: User. `PATCH /api/me`: `{display_name?,preferences?}` → User.
- User: `{id,username,display_name,is_admin,disabled,preferences,created_at}`. Preferências JSON limitado, sem execução de CSS/JS.

## Comunidades e conversas

- `GET/POST /api/guilds` body criação `{name}` → Guild `{id,name,owner_id}`.
- `GET /api/guilds/{id}/members` → User com `role` (owner/admin/member).
- `PATCH /api/guilds/{id}/members/{user_id}` `{role:"admin"|"member"}`; `DELETE` remove membro. Dono não removível/rebaixável implicitamente.
- `GET/POST /api/guilds/{id}/channels` body `{name,kind:"text"|"voice"}` → Channel `{id,guild_id,name,kind,last_seq}`.
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

- `POST /api/channels/{id}/media-token` → `{token,url,room,max_video_bitrate}`. TTL curto, identidade vincula usuário/sessão; só canal voice ou DM/group. `POST /api/channels/{id}/moderate` `{user_id,action:"mute"|"remove"}` →204, exige dono/admin comunidade. Desconexão global em reset/bloqueio.
- `POST /api/channels/{id}/uploads` `{name,size,content_type}` → `{id,url,headers}`; PUT direto do cliente ao storage. `POST /api/uploads/{id}/complete` → metadata após validação do objeto. `GET /api/uploads/{id}/download` → `{url}` com ACL corrente.
- `GET /api/admin/users` → Users. `PATCH /api/admin/users/{id}` `{disabled}` →User. `POST /api/admin/users/{id}/reset` `{password}` (senha atual do admin para reauth) → `{token,expires_at}`. `POST /api/admin/invites` `{expires_hours?,max_uses?}` → código de cadastro.
- `GET /api/admin/audit` → eventos sem segredos. `GET /api/admin/stats` → contagens e limites de configuração.

As respostas opcionais/null devem ser toleradas no cliente. Extensões de produto têm contrato adicional antes de aparecer na UI. Serviços ausentes retornam503 com explicação; nunca simular sucesso.
