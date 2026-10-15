use zed_extension_api::{self as zed, Result};

/// Identificador do language server declarado em `extension.toml`.
/// O sufixo `-lsp` segue o requisito do registro de extensoes do Zed para
/// extensoes que fornecem apenas um language server.
const SERVER_ID: &str = "angular-prime-ng-autoimport-lsp";

/// Helper LSP, escrito em JavaScript e embutido no wasm no momento da compilacao.
/// E entregue ao Node em base64 para nao depender de arquivos externos nem de
/// caracteres especiais na linha de comando.
const HELPER_JS: &str = include_str!("helper.js");

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut encoded = String::with_capacity(input.len().div_ceil(3) * 4);

    for chunk in input.chunks(3) {
        let first = chunk[0] as u32;
        let second = *chunk.get(1).unwrap_or(&0) as u32;
        let third = *chunk.get(2).unwrap_or(&0) as u32;
        let merged = (first << 16) | (second << 8) | third;

        encoded.push(BASE64_ALPHABET[(merged >> 18) as usize & 63] as char);
        encoded.push(BASE64_ALPHABET[(merged >> 12) as usize & 63] as char);
        encoded.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(merged >> 6) as usize & 63] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            BASE64_ALPHABET[merged as usize & 63] as char
        } else {
            '='
        });
    }

    encoded
}

/// Descarrega o helper: o Zed e o cliente; o import do PrimeNG e aplicado pelo
/// proprio helper via `workspace/applyEdit`.
struct AutoImportExtension;

impl zed::Extension for AutoImportExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!(
                "language server desconhecido: {}",
                language_server_id.as_ref()
            ));
        }

        const BOOTSTRAP: &str = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                "-e".to_string(),
                BOOTSTRAP.to_string(),
                base64_encode(HELPER_JS.as_bytes()),
                worktree.root_path(),
            ],
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(
            zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree)
                .ok()
                .and_then(|settings| settings.initialization_options),
        )
    }
}

zed::register_extension!(AutoImportExtension);
