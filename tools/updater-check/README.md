# Verificação independente do atualizador

Este workspace isolado testa o mesmo plugin usado pelo aplicativo: Tauri updater 2.13.3 com a extensão de tamanho documentada em `vendor/tauri-plugin-updater/HARMONY-PATCH.md`. Usa o `MockRuntime` oficial, consulta um servidor HTTP local descartável e baixa/verifica bytes. Não instala nem executa o arquivo recebido.

Na raiz do repositório, com Rust, Python 3 e Node no PATH:

```sh
npm ci
cargo build --locked --manifest-path tools/updater-check/Cargo.toml
python3 tools/updater-check/test_updater.py --output .local/qa-updater/result.json
```

`NODE_BIN` pode selecionar o executável Node; `UPDATER_CHECK_BIN` pode selecionar o binário compilado. Em Windows o script procura `.exe` automaticamente. A execução no macOS não comprova instalação no Windows. O workspace necessita das bibliotecas nativas do Tauri para a plataforma em que compila.

As chaves de teste são geradas dentro de um diretório temporário privado em `.local/qa-updater`, têm senha aleatória e são removidas ao terminar. A saída do assinador é capturada e não é impressa. A chave real de publicação não é necessária.

A matriz exercita 16 critérios: assinatura válida; bytes alterados; truncamento; chave incorreta; base64 inválido; bit alterado na assinatura; comentário assinado adulterado; versão do manifesto diferente da versão assinada; assinatura legada sem versão; downgrade; mesma versão; resposta grande com e sem Content-Length; limite exato; excesso de um byte; cancelamento durante stream já disponível.

Para acrescentar a verificação de um artefato de release baixado por outra etapa:

```sh
python3 tools/updater-check/test_updater.py \
  --artifact .local/release/Harmony_0.2.0_x64-setup.exe \
  --signature .local/release/Harmony_0.2.0_x64-setup.exe.sig \
  --public-key .local/release/updater-public-key.txt \
  --version 0.2.0 \
  --output .local/qa-updater/release-result.json
```

Isso só lê os bytes e a chave pública e os fornece ao mesmo plugin por loopback. A procedência do download e o hash do artefato devem ser registrados separadamente. A exceção de HTTP inseguro existe apenas neste harness; o aplicativo usa HTTPS.

## Canal público por HTTPS

Depois de publicar o feed, o segundo binário consulta exclusivamente o canal fixo `BersaneV/Harmony`, lê a chave pública e a versão esperada de `tauri.conf.json`, exige a URL exata do instalador e restringe os redirects a HTTPS nos hosts GitHub de releases. A seleção Windows x64 é explícita no MockRuntime; ela não transforma a execução no macOS em homologação Windows. Não habilita HTTP inseguro nem executa `install`.

```sh
cargo build --locked --manifest-path tools/updater-check/Cargo.toml --bin public-channel
tools/updater-check/target/debug/public-channel 0.1.0
tools/updater-check/target/debug/public-channel 0.2.0
```

Com o repositório e o canal em 0.2.0, a primeira execução deve baixar/verificar a assinatura e imprimir o SHA-256; a segunda deve retornar `no_update`. Falha HTTP, release ausente, destino inesperado ou assinatura inválida produz saída diferente de zero. Os testes unitários de URL/redirect não consultam o canal; o binário deve ser executado somente quando a publicação estiver disponível.
