# Recuperação PostgreSQL local — 12/11/2026

**PASS para dump e restauração do banco PostgreSQL em destino descartável separado.** O ensaio manteve a API e o banco de origem ativos e não escreveu no banco de origem. Não equivale à recuperação completa de banco e objetos S3.

Execução em `2026-11-12T17:16:22Z`, PostgreSQL `18.7 (Postgres.app)`, com [test_restore_postgres.py](../scripts/test_restore_postgres.py), SHA256 `84c6840adbc92d5bd6bd6724f1f4738aa1870c6701d6712ec30d6ecf3a8fe11d`.

O teste abriu uma transação somente leitura em isolamento repeatable read, exportou seu snapshot e forneceu o identificador ao `pg_dump --snapshot`. Inventário e digests da origem foram calculados no mesmo snapshot. Assim, gravações concorrentes da API não tornam a comparação dependente de horários diferentes.

Um banco com nome aleatório foi criado a partir de `template0`. `pg_restore --exit-on-error --no-owner` terminou com sucesso. Foram conferidos:

- Inventário idêntico de 23 tabelas, incluindo as tabelas de ACL granular.
- Contagens e digests canônicos idênticos das 411 linhas do snapshot.
- Colunas, constraints, índices, funções, views e triggers idênticos.
- Uma sequência restaurada com valor suficiente para os registros existentes.
- Remoção do banco de teste ao final, mantendo a origem em funcionamento.

O dump tinha 73.625 bytes, SHA256 `cff733bef41e55cc7e61f6974d17fada328605faef0bbfdcff1365d264065d7f`. Relatório e dump privados ficam em `.local/qa-restore/`; contêm material de recuperação e não devem ser publicados. O resultado agregado sem conteúdo de registros fica em `.local/qa-restore/result.json`.

## Reproduzir

É necessário ter ferramentas nativas da mesma versão principal do servidor, `DATABASE_URL` local e uma identidade com permissão para criar/remover o banco descartável. O script aceita somente conexão de origem em loopback, gera o nome do destino e nunca restaura sobre a origem.

```sh
HARMONY_PG_BIN=/caminho/para/postgresql/bin \
  python3 scripts/with-env.py python3 scripts/test_restore_postgres.py
```

A execução cria um dump privado e um banco temporário, valida o destino e o remove. `pg_dump` pode adquirir locks de leitura de catálogo/tabelas; não foi observado bloqueio operacional neste ensaio pequeno. O script não para serviços nem usa `DROP DATABASE` na origem.

## O que esta prova não cobre

Não foi executado o fluxo Docker de `backup.sh`/`restore.sh`, a cifra/restauração restic, a cópia do volume SeaweedFS, a recuperação de chaves em outro host ou uma falha física de disco. O snapshot PostgreSQL é consistente para o banco; objetos S3 modificados simultaneamente não participam desse snapshot. A prova de recuperação integral deve coordenar os dois armazenamentos conforme [OPERATIONS.md](OPERATIONS.md).

Papéis globais do cluster, ownership e grants externos ao banco não foram comparados; o restore usou `--no-owner` com a identidade local de teste.

Valores de sequência não usam a mesma semântica MVCC das linhas. O teste verificou que a sequência restaurada cobre os dados restaurados; não afirmou igualdade com uma sequência de origem que podia avançar durante o dump. O ensaio também não inicializou outra API sobre o banco recuperado: comparação de dados/esquema e sucesso do restore não substituem a jornada funcional no host de recuperação.
