# Angular PrimeNG Auto Import

A [Zed](https://zed.dev) extension that adds the PrimeNG import to your Angular
component (`.ts`) automatically when you use a `p-*` component in the template
(`.html`) — the same behaviour you get in VS Code.

## The problem

In VS Code, typing `<p-button>` without its import gets you a completion that
already carries the edit. The Angular Language Service delivers that edit through
a **VS Code client-only command**:

```json
{
  "command": {
    "command": "angular.applyCompletionCodeAction",
    "arguments": [[{ "changes": { "file:///.../dashboard.ts": [ ... ] } }]]
  },
  "additionalTextEdits": undefined
}
```

In plain LSP, `CompletionItem.additionalTextEdits` can only edit **the same
document**. Because the import lives in another file (the `.ts`), Angular ships
the edit through that custom command instead. Zed does not know it, so the tag
lands in the HTML and the import never reaches the `.ts`.

No `settings.json` tweak fixes this: it is a protocol gap, not a configuration
problem. The fix has to happen on the client side, which is what this extension
does. See [`docs/feature-request-zed-core.md`](docs/feature-request-zed-core.md)
for the upstream proposal.

## How it works

The extension declares an **auxiliary language server**
(`angular-prime-ng-autoimport-lsp`) for `HTML`, `Angular` and `TypeScript`. It
runs alongside the real `angular` language server without replacing it, and is a
JavaScript helper embedded in the `.wasm` (run with the Node binary Zed uses).

Flow:

1. Watches `textDocument/didChange` on `.html` files (400 ms debounce).
2. Reads the template and collects the PrimeNG components/directives in use —
   tags (`<p-button>`) **and** attributes (`pTemplate`, `[pSortableColumn]`, …).
3. Reads the sibling `.ts` and the selector map of the installed package.
4. Computes what is missing and applies it with `workspace/applyEdit`.

Two safeguards prevent useless imports:

- **NgModule graph**: it understands `ɵɵNgModuleDeclaration` and knows what each
  module exports. If `TagModule` is already in `imports: [...]`, `<p-tag>` does
  **not** get a redundant `import { Tag }`.
- **Per-file shadow**: since `applyEdit` changes the buffer (which is not saved
  yet), the helper remembers the expected result and does not re-apply it twice.

The map is built offline from the package's `package.json` (`exports`) and its
`.d.ts` files. With PrimeNG 21.1.9 that is **303 selectors** and **104 modules**.

`node_modules` is located by **walking up from the file itself** (like Node's
resolver), so it works both in a simple project and in the case where the Zed
worktree is the outer repository folder and the app sits one level below
(`my-app/my-app`).

## Install

This extension is not in the Zed registry (see the note below), so install it as
a dev extension:

1. `zed: install dev extension` from the command palette.
2. Pick the folder containing `extension.toml`.

Requires the `wasm32-wasip2` Rust target; Zed installs it automatically when Rust
came from rustup.

## Usage

1. Open a component `.html` and type a PrimeNG tag that is not imported yet, for
   example `<p-button label="ok"></p-button>`.
2. The import shows up in the sibling `.ts` (the buffer becomes dirty — just
   save it).

Before:

```ts
import { TableModule } from 'primeng/table';

@Component({
  selector: 'app-dashboard',
  imports: [TableModule],
  templateUrl: './dashboard.html',
})
export class Dashboard {}
```

After using `<p-button>` and `<p-select>` in the template:

```ts
import { TableModule } from 'primeng/table';
import { Button } from 'primeng/button';
import { Select } from 'primeng/select';

@Component({
  selector: 'app-dashboard',
  imports: [TableModule, Button, Select],
  templateUrl: './dashboard.html',
})
export class Dashboard {}
```

### Manual alternative

To apply on demand (or with the automatic mode off), use the code action in the
`.html`: `Ctrl+.` → **"PrimeNG: add import(s)"**.

## Configuration (optional)

In `.zed/settings.json`:

```json
{
  "lsp": {
    "angular-prime-ng-autoimport-lsp": {
      "initialization_options": {
        "autoImportOnChange": true,
        "package": "primeng",
        "debug": false
      }
    }
  }
}
```

| Option               | Default     | Purpose                                                     |
| -------------------- | ----------- | ----------------------------------------------------------- |
| `autoImportOnChange` | `true`      | Apply while typing. `false` keeps only the code action.      |
| `package`            | `"primeng"` | Package name (change it for a fork/alias).                  |
| `debug`              | `false`     | Logs decisions through `window/logMessage`.                  |

Unexpected helper errors go to `stderr`, which Zed captures in its log
(`zed: open log`).

## Requirements

- Node available to Zed (the same Node Zed already uses for other extensions).
- `node_modules/primeng` installed in the project.
- The `.ts` must contain `@Component(` and an `imports: [...]` array.

## Limitations (by design)

- **Does not save the file** — it only applies the edit to the buffer. Saving is
  up to you.
- Only acts when the sibling `.ts` (same name, same folder) exists and has
  `imports: [...]`. It does not guess another file.
- Only recognises what is in the package map. Unknown selectors are ignored (no
  wrong import is generated).
- Complements the `angular` language server; it does not replace any of it.

## Publishing note

Zed's publishing prerequisites state:

> Do not misuse the extension API to work around its current limitations.

This extension *is* a workaround for a current Zed limitation (Zed does not
execute the `command` returned by a completion item), so it may not be accepted
into the official registry. It is meant to be installed as a dev extension or
from source, and it doubles as a concrete test case for
[`docs/feature-request-zed-core.md`](docs/feature-request-zed-core.md).

## Development

```bash
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2 --release
# artifact: target/wasm32-wasip2/release/angular_prime_ng_autoimport_lsp.wasm
```

> Important: the target is **`wasm32-wasip2`** (a component). `wasm32-wasip1`
> produces a *core module* and Zed rejects it with
> `attempted to parse a wasm module with a component parser`.

Zed watches `extensions/installed/` and hot-reloads extensions, but it **does
not** restart a language server that is already running: restart Zed for a new
build to take effect.

## Structure

```
extension.toml     # manifest: registers the language server
Cargo.toml         # zed_extension_api 0.7.0, cdylib
src/lib.rs         # wasm: declares the server and spawns the helper (helper.js embedded)
src/helper.js      # the LSP helper (all the import logic)
docs/              # upstream feature request
```

## License

MIT — see [LICENSE](LICENSE).
