# Extensão local do limite de download

Esta pasta preserva o pacote `tauri-plugin-updater 2.13.3` publicado no crates.io, com suas licenças Apache-2.0/MIT e fontes. O marcador local `.cargo-ok` não é distribuído. Apenas `src/updater.rs` e `src/error.rs` foram alterados; `HARMONY.patch` contém o diff completo. A versão pública do crate permanece identificada como 2.13.3; o uso por caminho no lockfile identifica a extensão local.

- Pacote original: <https://crates.io/api/v1/crates/tauri-plugin-updater/2.13.3/download>
- SHA-256 do `.crate`: `855a336eb389d2c1502244fd48fa2d8cb487a430f691bbaed025195f99a04489`.
- Commit indicado pelo próprio pacote: `6bbd44d4ef254d835a12c6d7bdf2a8a61778031a`, caminho `plugins/updater` no [repositório oficial](https://github.com/tauri-apps/plugins-workspace/tree/6bbd44d4ef254d835a12c6d7bdf2a8a61778031a/plugins/updater).

O callback de progresso original não retorna erro. Um teste demonstrou que cancelar um `CancellationToken` dentro desse callback não interrompe necessariamente um stream já disponível: 2 MiB foram consumidos com limite externo de 64 KiB. A validação final bloqueava a instalação, mas não limitava o buffer.

A API adicional `Update::download_with_limit(max_bytes: u64, on_chunk, on_finish)`:

1. rejeita `Content-Length` acima do limite antes de consumir o corpo;
2. usa `checked_add` e rejeita um chunk que excederia o limite antes de acrescentá-lo ao buffer ou chamar o callback;
3. cede uma vez entre chunks para que cancelamento e timeout do chamador avancem;
4. mantém, sem alterações, a verificação minisign e da versão assinada do plugin original.

`download` mantém a API anterior e delega sem limite explícito. O novo erro `DownloadTooLarge` faz parte do enum já marcado `non_exhaustive`. O limite descreve bytes acumulados do corpo; não promete um teto exato do RSS total do processo ou dos buffers internos de TLS/HTTP.

Reprodução: `tools/updater-check/test_updater.py`, após compilar seu workspace. O harness usa `MockRuntime`, transporte HTTP somente em loopback, chaves descartáveis e os métodos reais de consulta/download; nunca chama `install`. Os 16 critérios incluem assinaturas, adulteração, versão, downgrade, teto com/sem Content-Length, fronteira exata e cancelamento.

Ao atualizar o plugin, rever a necessidade deste patch e repetir a matriz. Não transferir silenciosamente a extensão para outra versão ou substituir a verificação criptográfica por uma implementação paralela.
