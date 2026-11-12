# Banco embarcado e migração

O servidor e o worker usam um arquivo SQLite no mesmo volume local. Não há
PostgreSQL na execução normal. O cliente Windows continua usando a API; ele não
recebe acesso ao arquivo do servidor. O adaptador fica em `harmony-database`,
com SQL específico de SQLite, sem tradução de consultas em tempo de execução.

`DATABASE_URL=sqlite:/data/harmony.db` é a configuração de implantação. API e
worker podem abrir o mesmo arquivo; não distribua esse arquivo por NFS, SMB ou
volumes de rede. Essa configuração é para uma instância do Harmony com processos
locais, não para múltiplas réplicas em hosts diferentes.

## Persistência e concorrência

- SQLx 0.9.0 e libsqlite3-sys 0.37.0 fixam SQLite 3.51.3, que contém a correção
  upstream da [corrida de reset do WAL](https://www.sqlite.org/wal.html#walresetbug).
- Conexões ativam WAL, `synchronous=FULL`, chaves estrangeiras e espera de escrita
  de 15 segundos. Transações com leitura seguida de mutação começam com
  `BEGIN IMMEDIATE`. O lock único de escrita substitui locks de linha/advisory do
  PostgreSQL e mantém ACL, idempotência, reserva de cota e fencing do worker.
- UUIDs usam 16 bytes; JSON permanece texto; comparações temporais usam
  `julianday` para aceitar timestamps UTC importados e novos. A view de permissões
  mantém precedência de cargos e overrides, bypass owner/admin e gate de VIEW.
- API/worker mantêm lease compartilhado em `harmony.db.lock` até sair. Ferramentas
  de manutenção exigem lease exclusivo. Caminhos são canonicalizados antes de
  abrir tanto o banco quanto o lock, inclusive quando a configuração usa symlink.

## Busca

A busca mantém a configuração anterior `plainto_tsquery('simple')`, com AND entre
lexemas. Usar diretamente o tokenizer padrão do FTS5 mudaria hífens compostos,
emails, números e URLs. `harmony-search` conserva a máquina de estados do parser
de texto PostgreSQL sob a licença PostgreSQL, com um adaptador UTF-8 limitado;
o FTS5 indexa os bytes dos lexemas em hexadecimal. Isso evita reinterpretar a
pontuação. A origem, licença, limites e adaptações estão em
`crates/search/vendor/README.md`.

A migration 2 recompõe o índice a partir das mensagens. O startup da API e
`harmony-db migrate` concluem o backfill em lotes de 200, com retomada após
interrupção. Envio, edição e exclusão atualizam mensagem e índice na mesma
transação. Mensagens apagadas e canais sem VIEW permanecem fora dos resultados.

A comparação independente registra 416 casos de lexemas e 69 consultas sobre
esses documentos, obtidos do PostgreSQL 18.7 C.UTF-8. Inclui pontuação, hífens,
HTML, URLs, emails, decimais, acentos, alfabetos e sequências Unicode. Não é uma
afirmação de igualdade universal entre todos os locales e versões de Unicode.
Para conferir a fixture sem modificá-la, configure o `DATABASE_URL` PostgreSQL
antigo no ambiente e rode `python3 scripts/verify-search-postgres.py --psql CAMINHO`.
A consulta usa somente as entradas sintéticas da fixture, em transação read-only.

## Importar uma instalação PostgreSQL existente

1. Faça backup do banco e dos objetos atuais. Preserve a instalação anterior
   para rollback. Verifique espaço para banco, objetos e cópia de segurança.
2. Pare API e worker antigos para o corte definitivo. Para um ensaio sem corte,
   pode mantê-los em execução e usar `--snapshot-only`; esse resultado não está
   pronto para substituir a instalação ativa.
3. Com a URL PostgreSQL em `DATABASE_URL`, execute:

   ```sh
   python3 scripts/migrate-postgres-to-sqlite.py --output /data/harmony.db --writers-stopped
   ```

   O destino precisa ser novo. O script nunca sobrescreve banco existente. Ele
   lê um snapshot PostgreSQL `REPEATABLE READ READ ONLY`, exige schema 4 e copia
   todas as 25 tabelas, incluindo hashes de senha, sessões, preferências, ACL,
   outbox e estados do worker. Verifica contagens/digests por tabela, integridade
   referencial e integridade SQLite. O relatório privado fica ao lado do banco.
4. Migre e confira os objetos conforme `docs/LOCAL-STORAGE.md`. O importador de
   banco não copia anexos. Não inicie o novo serviço antes de verificar ambos.
5. Mude `DATABASE_URL` para `sqlite:/data/harmony.db` e rode
   `harmony-db migrate`. Isso aplica migrations posteriores e o índice de busca.
6. Inicie API/worker, confira login, histórico, anexos, busca, ACL e processamento.
   O rollback para a cópia antiga deve ocorrer antes de aceitar novas escritas;
   escritas feitas após o corte exigem reconciliação, não uma simples troca de URL.

O importador e as ferramentas de manutenção Python destinam-se ao host Linux ou
macOS do servidor, com `fcntl`. O aplicativo desktop Windows não precisa deles.
`harmony-db query` é um console SQL local para operadores; lê SQL do stdin e não
é uma rota HTTP. Nunca exponha esse console ou o arquivo de banco aos clientes.

## Provas de regressão

`cargo test --workspace -- --include-ignored` exercita SQLite real, concorrência
entre pools, autenticação, ACL, busca e o lease com Python. Os scripts
`scripts/smoke.mjs`, `crates/server/tests/acl.mjs`, `scripts/test_worker.mjs` e
`scripts/test_local_storage.mjs` exercitam a API e o worker. O teste
`scripts/test_migrate_postgres_sqlite.py` cobre cópia, preservação de JSON/hash,
recusa de destino existente, schema errado, FK inválida e exclusão de manutenção.
O snapshot PostgreSQL real também foi importado e conferido; isso não afirma que
a implantação remota foi migrada.
