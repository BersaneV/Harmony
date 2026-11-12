# Arquivos privados no servidor único

O perfil simples usa `HARMONY_STORAGE_BACKEND=local` e um diretório compartilhado entre a API e o worker, definido por `HARMONY_STORAGE_DIR`. Não exige SeaweedFS ou outro serviço S3. O adaptador `s3` permanece disponível para operação explícita e ferramentas de migração; não é ativado por detectar credenciais antigas no ambiente.

O volume contém arquivos com nomes SHA-256 de 64 caracteres, derivados das chaves lógicas registradas no banco. Nomes enviados pelos usuários não são usados como caminhos. O diretório é privado (`0700`) e os arquivos são `0600`; API e worker precisam executar com o mesmo usuário do sistema. O adaptador local usa operações relativas a um descritor de diretório aberto, rejeita links simbólicos em leituras e não segue o destino de um link durante publicação atômica. Arquivos `.stage-<UUID>` são temporários, não fazem parte do backup e são removidos após cancelamento ou por coleta de restos antigos.

## Contrato HTTP e autorização

As operações de reserva, conclusão, download, metadados e derivados mantêm os contratos de produto. As URLs retornadas apontam para `HARMONY_PUBLIC_API_URL/api/files/{id}/{kind}`, onde a origem pública é definida explicitamente pelo administrador. O servidor não constrói links a partir de cabeçalhos Host enviados pelo cliente.

- A reserva emite uma URL de PUT válida por até cinco minutos, limitada ao arquivo, tipo e tamanho reservados, usuário e sessão.
- O PUT recebe o corpo em fluxo, possui prazo máximo de 120 segundos e aceita até quatro transferências de entrada simultâneas. Arquivos temporários não ficam enfileirados sem limite.
- A publicação do PUT e a conclusão usam a mesma exclusão transacional do SQLite. Um PUT iniciado antes da conclusão não consegue alterar o original já publicado.
- A conclusão valida tamanho e assinatura do conteúdo e mantém o original imutável. O worker publica derivados identificados pela tentativa vigente e preserva os controles de leases, cotas e limpeza.
- URLs de leitura duram até 60 segundos. No início de cada pedido, o servidor verifica novamente sessão, reset de senha, acesso ao canal e remoção da mensagem. Uma URL anteriormente emitida deixa de funcionar depois dessas revogações.
- Arquivos e cópias são transferidos em blocos de 64 KiB; não é necessário carregar um original grande inteiro na memória. GET aceita um intervalo HTTP de bytes, inclusive sufixo; intervalos inválidos retornam 416. Downloads não disputam os quatro slots de staging dos uploads.
- Uma transferência de leitura já iniciada pode terminar após revogação; bytes entregues não podem ser recolhidos. O próximo pedido, incluindo um novo intervalo, passa pela autorização novamente.

O tamanho configurável de anexo continua disponível. Os limites separados de entrada/saída e sandbox do worker continuam valendo para processamento de mídia. Espaço em disco deve acomodar dados publicados e a margem temporária das transferências; a cota lógica do produto não substitui essa margem operacional.

## Migrar dados existentes do S3

Primeiro importe o banco com `scripts/migrate-postgres-to-sqlite.py`. Para uma migração operacional, interrompa os escritores antigos (API e worker) e mantenha banco e bucket antigos para recuperação. O comando abaixo requer um banco SQLite offline e um diretório de destino que ainda não exista:

```sh
python3 scripts/migrate-s3-to-local.py \
  --database /caminho/novo/harmony.db \
  --source-env /caminho/privado/deploy-antigo.env \
  --output /caminho/novo/files \
  --writers-stopped
```

Para um ensaio enquanto a instalação antiga continua ativa, use `--snapshot-only` no lugar de `--writers-stopped`. O relatório desse ensaio indica `cutover_ready: false`; ele não autoriza trocar a instância para os dados copiados.

A ferramenta usa as credenciais S3 do arquivo de origem, faz HEAD/GET e não altera o bucket. Copia as chaves referenciadas pelo banco, verifica tamanho, SHA-256 dos bytes gravados e estabilidade do ETag. Um original ou derivado pronto ausente causa falha. Uma chave planejada ou pendente ainda inexistente pode ser registrada como `not_present`; não recebe verificação fictícia. O banco deve permanecer com o mesmo hash durante a operação.

O relatório privado fica ao lado do diretório de destino, com sufixo `.migration.json`. Se houver falha, os arquivos parciais ficam disponíveis para diagnóstico, o relatório marca `FAIL` e não se deve iniciar a nova instância com esse destino. Nenhum destino existente é sobrescrito. Não coloque `.env`, relatórios privados, bancos ou arquivos dos usuários no Git.

## Validação

```sh
cargo test -p harmony-storage
python3 scripts/test_migrate_s3_local.py
cargo build -p harmony-server -p harmony-media-worker -p harmony-database
node scripts/test_local_storage.mjs
HARMONY_TEST_WORKER=true FFMPEG_PATH=/caminho/ffmpeg \
  FFPROBE_PATH=/caminho/ffprobe node scripts/test_local_storage.mjs
```

O teste HTTP inicia uma API isolada com banco e arquivos temporários, sem S3. Verifica URLs, concorrência entre PUT/conclusão, MIME, leitura por intervalo, ACLs, reset, remoção e reinício. A opção do worker executa também a suíte existente de processamento real, concorrência, recuperação, limites e fencing com FFmpeg. Os testes de migração Python usam uma fixture HTTP local; o ensaio contra um bucket S3 real é uma evidência separada. Esses testes não substituem homologação do cliente Windows nem da hospedagem externa.
