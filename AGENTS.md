# Acordos de trabalho — Harmony

## Escopo

Este é o projeto pessoal Harmony, no repositório BersaneV/Harmony. Não reutilizar credenciais, código, referências privadas ou regras de produto de outros projetos. Conferir conta autenticada e repositório antes de qualquer escrita remota.

## Comunicação e execução

- Comunicar em português do Brasil, sem emojis salvo solicitação.
- Trabalhar dentro do escopo autorizado e preservar alterações existentes.
- Conferir checkout, branch, status e mudanças antes de editar. Decisão de Victor em 12/11/2026: desenvolvimento individual diretamente na `main`, sem abertura de PR. Preservar trabalho existente e validar antes de publicar.
- Separar implementação, validação, revisão, merge e publicação. Não executar merge/deploy por presumir que a capacidade técnica é autorização.
- Para tarefas longas, manter um único plano local com task_plan.md, findings.md e progress.md. Não publicar registros com informações privadas.

## Arquitetura

- Usar ARCHITECTURE.md como decisão inicial e ROADMAP.md como ordem de provas; atualizar decisões quando houver mudança autorizada, preservando o histórico Git.
- Manter Domínio/Aplicação independentes de frameworks e infraestrutura; contratos internos com adaptadores nas bordas.
- Resolução, FPS e bitrate são controles de produto. Mostrar parâmetros solicitados e valores efetivos; não prometer desempenho sem evidência.
- Orçamento operacional R$ 0: sem upgrade automático, provisionamento faturável ou contratação implícita.
- Não tratar a v1 como E2EE nem afirmar que administração não pode acessar conteúdo persistido.

## Segurança e validação

- Não versionar tokens, senhas, cookies, dados de contas, bancos, backups ou chaves de assinatura.
- Autorizar operações no servidor, inclusive acesso por WebSocket, mídia, busca e anexos.
- Fixar dependências/lockfiles e revisar licenças e binários antes da distribuição.
- Executar os menores testes úteis pelo caminho real. Documentação, build e mocks não substituem captura e reprodução no Windows.
- Registrar limitações e NOT_RUN; nunca transformar ausência de evidência em PASS.
