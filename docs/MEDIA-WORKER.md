# Processamento de anexos

O executável `harmony-media-worker` processa anexos confirmados pela API. É um processo separado, sem porta HTTP. Não processa chamadas LiveKit, não grava conversas e não acessa URLs fornecidas pelos usuários. O arquivo original permanece intacto.

## Contrato de produto

- PNG/JPEG/GIF/WebP e formatos de vídeo/áudio reconhecidos pelo FFmpeg: metadados restritos e uma miniatura JPEG, limitada a 640×640. GIF usa o primeiro quadro. Áudio usa uma forma de onda dos primeiros 30 segundos, em 640×160.
- MP4 com codecs compatíveis: derivado MP4 por remux, sem recodificação, com `moov` antes dos dados de mídia (`+faststart`). Não produz múltiplas qualidades nem converte qualquer codec para reprodução no navegador. O codec original continua determinando a compatibilidade do cliente.
- Metadados da API: tipo, formato normalizado, largura/altura codificadas, duração quando válida e presença de áudio. Tags arbitrárias, autor e GPS não são expostos na API. O remux remove tags do contêiner/capítulos; não promete remover metadados eventualmente presentes dentro dos pacotes do codec.
- Formatos não destinados a mídia são `unsupported`. Mídia inválida, codec indisponível ou limites excedidos terminam em `failed`, preservando o download do original. Isso não equivale a varredura antivírus.

`GET /api/uploads/{id}/media` retorna:

```json
{
  "status": "ready",
  "metadata": {"kind":"video","format":"mp4","width":160,"height":96,"duration_seconds":1.0,"has_audio":true},
  "derivatives": [
    {"kind":"thumbnail","content_type":"image/jpeg","size":2500,"width":160,"height":96},
    {"kind":"faststart","content_type":"video/mp4","size":24000,"width":160,"height":96}
  ],
  "error_code": null
}
```

Estados: `queued`, `processing`, `ready`, `unsupported`, `failed`. Enquanto não há resultado, `metadata` é `null` e `derivatives` é vazio. O cliente consulta a cada 2–3 segundos durante processamento; esta versão não publica evento WebSocket de conclusão. `Message.attachments[].media_status` informa o estado observado na leitura da mensagem, sem obrigação de permanecer atualizado sozinho.

`GET /api/uploads/{id}/derivatives/{thumbnail|faststart}` retorna `{url, expires_in:60, content_type, size}`. Status e assinatura de derivados exigem sessão vigente e `VIEW` atual do canal; antes de associar a uma mensagem, somente o autor pode acessá-los. Mensagens excluídas bloqueiam todos esses acessos. Bucket e derivados são privados. URLs previamente emitidas têm janela residual de até 60 segundos; revogar um cargo não invalida magicamente uma assinatura já entregue.

## Fila, concorrência e cota

A finalização do upload grava `media_jobs` na mesma transação que publica o original. A migration 0004 inclui uploads antigos já prontos. Cada upload tem um job da versão 1 da pipeline.

O claim usa PostgreSQL, `FOR UPDATE SKIP LOCKED`, lease de 120 segundos e UUID da tentativa. Um processo executa um job por vez. Heartbeat a cada 5 segundos renova somente a tentativa vigente e ainda válida. Falhas transitórias de armazenamento, banco, I/O e timeout podem repetir até três tentativas, com espera de 5/10 segundos. Falhas permanentes não repetem. Jobs prontos não são executados novamente. Após morte do processo, outra execução coleta a tentativa vencida e retoma o job; o lease não é resetado por reiniciar o serviço.

Antes de qualquer gravação S3, a tentativa e todas as chaves possíveis são registradas no banco. Cada tentativa tem seu próprio prefixo. Publicação e coleta seguram o mesmo lock de job e o lock global de cota durante as operações S3, limitadas a 20 segundos por requisição. Uma tentativa obsoleta não pode gravar depois que o coletor ou o substituto adquiriu esse lock. Uma interrupção após PUT e antes de commit conserva o registro de limpeza e a reserva de bytes.

A cota global conta originais prontos, uploads ainda reservados, bytes dos derivados publicados e orçamento de tentativas ainda não coletadas. A tentativa reserva até `WORKER_MAX_OUTPUT_BYTES` antes de começar. Se não couber, fica `queued` com `error_code: quota_wait`, sem consumir tentativa, e tenta novamente após 60 segundos. Isso pode adiar uma miniatura pequena quando falta espaço para a reserva integral; o sistema não ultrapassa a cota para processá-la.

O worker remove derivados de tentativas falhas, substituídas, vencidas e mensagens excluídas. O original não é removido por essa rotina. O resultado só é publicado após revalidar o original e bloquear a mensagem contra exclusão concorrente. Chaves nunca publicadas também continuam rastreadas. Diretórios temporários abandonados por mais de uma hora são removidos; a execução normal os remove ao terminar.

## Isolamento e limites

O supervisor possui apenas as credenciais PostgreSQL/S3 necessárias. Faz download assinado de uma chave canônica `objects/{upload_id}/original`, com redirecionamentos desabilitados, tamanho conhecido e leitura limitada. O parser recebe somente arquivo local em diretório temporário privado, argumentos fixos e ambiente limpo, sem credenciais. Não há shell nem URL de usuário na invocação.

FFmpeg/ffprobe usam protocolo `file` e uma lista restrita de demuxers, sem HLS, concat ou playlists. A imagem de produção compila FFmpeg sem protocolos de rede. O parser tem um thread de codec/filtro, `max_alloc` de 64 MiB por alocação, limite de pixels antes de decodificar, stdout e stderr limitados separadamente a 64 KiB, timeout por comando e limite de tamanho de arquivo pelo sistema operacional. O total dos derivados também é validado antes da publicação.

No Linux, exige Landlock ABI ≥3 (kernel ≥6.2 com Landlock habilitado) e seccomp. O parser pode ler seu diretório temporário, seu executável e bibliotecas de runtime; pode escrever apenas no temporário e `/dev/null`. Não pode ler `/proc`, credenciais ou outros arquivos do app. Seccomp bloqueia sockets/rede, ptrace, acesso à memória de outros processos, namespaces, mounts, io_uring e forks de processos. Threads são permitidas; `clone3` retorna ENOSYS para o fallback filtrado de `clone`. `PDEATHSIG` encerra o parser se o supervisor morrer. Falha em aplicar o sandbox impede processamento; não existe fallback sem isolamento.

A implantação ainda deve usar usuário sem privilégios, capabilities removidas, filesystem somente leitura, tmpfs, limite de processos, memória e CPU no container. O serviço supervisor precisa alcançar apenas PostgreSQL e S3 na rede interna; o bloqueio de rede do parser não substitui a configuração de rede do host.

No macOS de desenvolvimento, `sandbox-exec` aplica isolamento de arquivos/rede; o supervisor mede RSS a cada 100 ms e encerra o grupo de processos no timeout/cancelamento. O limite de RSS é observado, não um hard limit de kernel. Mac não oferece o mesmo `PDEATHSIG`: SIGKILL do supervisor não garante encerramento imediato do parser órfão. Esse caminho é QA local; a implantação suportada do worker é Linux com os limites do container. A prova macOS não comprova Landlock/seccomp Linux.

## Configuração

| Variável | Padrão / uso |
|---|---|
| `DATABASE_URL` | PostgreSQL, obrigatória |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | S3 interno autenticado, obrigatórias |
| `S3_REGION`, `S3_BUCKET` | `us-east-1`, `harmony` |
| `HARMONY_STORAGE_QUOTA_BYTES` | 1 GiB, idêntica à API |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `/usr/bin/ffmpeg`, `/usr/bin/ffprobe`; executáveis locais confiáveis |
| `WORKER_TEMP_DIR` | `/tmp/harmony-media` |
| `WORKER_TIMEOUT_SECONDS` | 30 por comando; 1–120 |
| `WORKER_LEASE_SECONDS` | 120; 30–600 e ao menos timeout+30 |
| `WORKER_MAX_INPUT_BYTES` | 25 MiB; máximo 100 MiB |
| `WORKER_MAX_OUTPUT_BYTES` | 32 MiB; 64 KiB–128 MiB, por tentativa |
| `WORKER_MAX_PIXELS` | 16.777.216; máximo 33.554.432 |
| `WORKER_MEMORY_BYTES` | 512 MiB; 128 MiB–2 GiB |

Comandos:

```sh
harmony-media-worker                 # loop, um job por processo
harmony-media-worker --once          # coleta e processa no máximo um job
harmony-media-worker --drain         # esgota os jobs elegíveis agora; não espera retries futuros
harmony-media-worker --check-sandbox # executa FFmpeg/ffprobe no sandbox sem conectar ao banco
```

A configuração ainda é validada em `--check-sandbox`, incluindo presença das variáveis de conexão; nenhum segredo é impresso. Códigos de erro são fixos e não contêm saída bruta do parser, conteúdo do anexo, URLs ou credenciais. Falha do coletor preserva registros/cota e encerra o processo com erro para o supervisor reiniciar; não descarta registros fingindo sucesso.

## Validação

`node scripts/test_worker.mjs`, com ambiente carregado, API/S3/PostgreSQL ativos, `FFMPEG_PATH`, `FFPROBE_PATH` e `PSQL_PATH`: arquivos sintéticos reais, dois workers, JPEG/MP4 e bytes originais, ACL, cota, retries finitos, morte real de processo, retomada por lease, tentativa antiga concorrente, exclusão durante processamento e limpeza. Não usar dados de usuários para a prova.

`python3 scripts/test_worker_sandbox.py`: negativos independentes com executáveis C inofensivos e canários, sem alterar os binários FFmpeg. O script verifica o isolamento observado na plataforma em que é executado. Relatórios locais em `.local/qa-worker/result.json` e `.local/qa-worker-sandbox/result.json` identificam o hash do binário testado. Linux deve passar os mesmos negativos e a prova com FFmpeg real no CI/host de destino; documentação e compilação não substituem a execução.
