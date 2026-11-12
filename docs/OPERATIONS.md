# Operar o Harmony

Servidor: Linux dedicado, Docker Engine e Compose. O Compose usa rede do host para a mídia e **não é homologado no Docker Desktop de macOS/Windows**. O aplicativo Windows é cliente; ele não instala PostgreSQL ou LiveKit no computador de cada participante.

## Primeiro start local do servidor Linux

```sh
python3 scripts/configure.py
docker compose up -d --build
printf 'fs.configure -locationPrefix=/buckets/ -volumeGrowthCount=1 -apply\n' | docker compose exec -T storage weed shell
python3 scripts/storage-init.py
```

Os segredos ficam em `.env` e `.local/deploy/`, com permissão0600 e ignorados pelo Git. O script recusa substituir arquivos existentes. A senha inicial está no campo `HARMONY_BOOTSTRAP_PASSWORD`; o bootstrap só cria o primeiro administrador quando não existe conta. Não compartilhe esse arquivo. O backend deve recusar chaves ausentes/fracas. Para o cliente web de desenvolvimento: `npm ci && npm run dev`; informe o servidor `http://127.0.0.1:8080`.

O entrypoint do storage copia a configuração privada para um tmpfs com acesso exclusivo do UID1000 e depois entrega ao entrypoint oficial, que reduz os privilégios. O arquivo no host continua0600. O gateway de arquivos18083 limita o corpo do upload ao valor gerado de `HARMONY_MAX_UPLOAD_BYTES`; ao alterar essa variável, ajuste também o `max_size` em `caddy.json`. A URL de PUT assina o tamanho exato reservado.

O login normal não usa token de administração do LiveKit nem chaves S3. Essas chaves ficam no servidor. Não existe cadastro aberto: crie convite no painel administrativo e entregue pelo contato combinado com o usuário.

## Host público

Prepare um checkout novo e execute `python3 scripts/configure.py --domain seu-dominio.example`. Antes de ligar serviços públicos, os quatro nomes `app`, `media`, `files` e `turn` precisam apontar para o IP do host. DNS, IP público, limites da conta e certificados não são criados pelo projeto.

Depois de conferir a configuração: `docker compose --profile public up -d --build` e `python3 scripts/storage-init.py`. Caddy é compilado com módulo L4 fixado; o binário Caddy comum não substitui esse build.

Execute também a configuração de crescimento de volumes mostrada acima. SeaweedFS cresce sete volumes por padrão; usar um volume por vez evita reservar espaço demais no host pequeno. Essa configuração não remove volumes existentes. A sinalização de mídia passa pelo gateway HTTP privado18082: cada conexão/reconexão RTC é autorizada pela sessão e ACL correntes antes de chegar ao LiveKit, inclusive com token de mídia renovado. Chamadas já abertas são reconciliadas a cada5s. Não existe revogação instantânea de pacotes já transmitidos.

| Porta externa | Função |
|---|---|
| TCP80 | ACME/renovação de certificados |
| TCP443 | Aplicação, mídia sinalizada, arquivos e TURN/TLS separados por SNI |
| UDP7882 | ICE/WebRTC |
| TCP7881 | ICE/TCP de contingência |
| UDP3478 | TURN/UDP |

No firewall, bloquear acesso externo a15432,8080,7880,8333,5349,18081,18082,18083,2019 e às portas administrativas SeaweedFS. PostgreSQL, API, S3 e HTTP do LiveKit escutam em loopback. O listener TURN5349 exige PROXYv2 do proxy local confiável; não deve ficar público. O endpoint de health não comprova conectividade WebRTC.

LiveKit1.13.11 anuncia TURN/TLS443 no código da versão fixada, mesmo recebendo o tráfego terminado pelo Caddy em5349. A validação completa depende de DNS/certificado e clientes em redes diferentes. A configuração não comprova que o provedor permitirá UDP ou acesso público à VM.

## Controles de recursos

O Compose limita memória por serviço e rotação de logs. `HARMONY_MAX_UPLOAD_BYTES`, `HARMONY_STORAGE_QUOTA_BYTES` e `HARMONY_MAX_VIDEO_BITRATE` definem limites explícitos da instância. O cliente exibe o teto de mídia recebido; o teto de bitrate do encoder não representa cobrança de tráfego, controle de disco físico nem proteção contra um cliente modificado.

Um host público ainda precisa de medição/limite na rede, margem de segurança de disco, política de admissão e bloqueio de fluxos ativos. **Sem a integração com o host escolhido não há garantia de custo zero.** Nenhum script cria VPS, adiciona cartão, ativa upgrade automático ou contrata domínio. Os serviços locais funcionam sem assinatura. Não habilite o piloto com dados importantes antes de executar as provas de rede, armazenamento e restauração.

## Backup consistente e restauração

Instale restic e configure `RESTIC_REPOSITORY` para destino independente e `RESTIC_PASSWORD_FILE` para uma chave fora do repositório. Inicialize o destino conscientemente com `restic init`. `sh scripts/backup.sh` interrompe chamadas e serviços de escrita, gera dump PostgreSQL e copia o volume SeaweedFS parado, preservando objetos e metadados juntos. Em seguida cifra o snapshot com restic e religa somente os serviços que estavam rodando. Não há cópia de arquivos de um PostgreSQL ativo como substituto do dump.

O backup inclui segredos necessários à recuperação; a cifra e a chave externa são obrigatórias. Backups no mesmo disco do host não são proteção contra perda da VM. A rotina não exclui snapshots antigos automaticamente; configure retenção somente após definir a política de dados.

Restaure um snapshot com `restic restore SNAPSHOT --target /destino-independente`. No checkout vazio correspondente ao commit registrado, execute `sh scripts/restore.sh /caminho/absoluto/para/o/backup harmony-restauracao`. O segundo argumento é um projeto Compose novo: a rotina recusa nomes já existentes, banco/storage preenchidos e porta15432 ocupada. Uma pasta nova sozinha não isola volumes Docker. Os serviços públicos permanecem parados ao terminar. Valide contas, mensagens, anexos e chaves antes de abrir a rede. O script Compose ainda exige ensaio no host Linux real; provas locais e sua cobertura constam em `VALIDATION.md`.

## Build e atualizações Windows

`npm run desktop:build -- --bundles nsis` gera o instalador `.exe`. A workflow usa runners padrão em repositório público. O acionamento manual com `package=true` guarda o instalador e SHA256 em uma release de desenvolvimento em rascunho, após os testes de servidor. Não usa armazenamento de artifacts/caches do Actions; não publica automaticamente uma versão estável.

O instalador inicial não tem assinatura Authenticode. Não existem atualizações automáticas sem chave de assinatura configurada; distribuir uma nova versão exige baixar e verificar o instalador. Não inventar chave pública/updater nem reutilizar chaves de outro projeto. Uma compilação Windows bem-sucedida não homologa microfone/captura/eco/atalhos ou desempenho em máquinas reais.

Referências: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [limites de releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [restic](https://restic.readthedocs.io/en/stable/).

## Serviço de mídia e manutenção

O Compose inicia `media-worker` após a API saudável. Requer kernelLinux6.2+ com Landlock ABI3 e seccomp disponíveis. Testar `docker compose run --rm media-worker --check-sandbox` antes de liberar uploads em novo host. A imagem compila FFmpeg9.0.2 da fonte oficial com SHA256 fixado, sem suporte de rede, GPL ou nonfree. Worker uid10001, rootfs somente leitura, tmpfs128MiB, memória768MiB, CPU1 e limite64 processos; subprocessos têm restrições adicionais. Consulte MEDIA-WORKER.md para leases/retries/limites.

`backup.sh` agora para o worker junto dos demais escritores; restauração mantém todos parados até inspeção. Não executar um worker externo ao Compose durante backup. A chave de atualização do desktop é custódia do mantenedor e exige backup criptografado próprio; não pertence ao backup de uma instância.
