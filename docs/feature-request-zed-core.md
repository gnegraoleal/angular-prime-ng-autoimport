# Feature request: execute the `command` returned by completion items (Angular auto-import in templates)

**Target repo:** `zed-industries/zed`
**Component:** LSP client / completion
**Environment**

| | |
| --- | --- |
| Zed | `1.24.2+stable.373.fb69067729cb16a7f6135e2c1600c26a28c59659` (Windows x64) |
| Extension | `angular` (`zed-industries/zed-angular`) |
| `@angular/language-server` | `22.1.7` |
| `@angular/core` | `22.1.5` |
| PrimeNG | `21.1.9` |

## Summary

For Angular templates, the Angular Language Service does not return the
auto-import edit through the standard LSP field. It returns an empty/`undefined`
`additionalTextEdits` plus a **client-side command**,
`angular.applyCompletionCodeAction`, which carries the real workspace edit:

```json
{
  "label": "Button",
  "additionalTextEdits": undefined,
  "command": {
    "title": "",
    "command": "angular.applyCompletionCodeAction",
    "arguments": [
      [
        {
          "changes": {
            "file:///.../src/app/dashboard/dashboard.ts": [
              { "newText": "\nimport { Button } from 'primeng/button';", "range": { ... } },
              { "newText": "imports: [TableModule, Button]", "range": { ... } }
            ]
          }
        }
      ]
    ]
  }
}
```

Zed ignores that `command`, so the import never reaches the component. Result:
you can use `<p-button>` in the template and the component keeps compiling with
an unimported `Button` — the exact feature VS Code users rely on every day.

## Why the standard LSP path can't carry it

`CompletionItem.additionalTextEdits` may only edit **the same document** as the
completion. Angular's auto-import must edit the sibling `.ts` from a `.html`
completion, which the LSP does not allow. That is precisely why Angular moved it
into a client command (`angular.applyCompletionCodeAction`) — implemented in
VS Code's Angular extension via `applyCodeActionCommand`. The code-action path
does not help either: the template contains no diagnostics for the unknown
element, so `textDocument/codeAction` returns nothing to "fix" the missing
import.

## Expected

Selecting the completion (or accepting it) also applies the workspace edit
carried in `CompletionItem.command`, so the import lands in the `.ts`.

## Actual

The `command` is dropped. Nothing is applied.

## Evidence

1. Raw LSP traffic against the real server (`completionItem/resolve` for
   `p-button` in an `.html`) returns `additionalTextEdits: undefined` and the
   `angular.applyCompletionCodeAction` command shown above.
2. `grep` on the Zed binary: `workspace/applyEdit` and `additional_text_edits`
   are present, `applyCompletionCodeAction` is **not**.
3. `zed-angular` `0.0.7` `extension.wasm`: 0 occurrences of
   `applyCompletionCodeAction`.
4. Injecting `<p-button>` / `<nao-existe-abc>` in-memory produces 0 diagnostics
   and 0 code actions, so there is no `quickfix` fallback.

## Proposal

Any of these would fix it, in increasing scope:

1. **Execute `CompletionItem.command` after accepting a completion** when the
   server returns one — at minimum for `workspace/applyEdit`-shaped payloads.
   Zed already implements `workspace/applyEdit` as a client request, so the
   machinery exists; the gap is running the command the completion carries.
2. **Whitelist/bridge known commands**: translate
   `angular.applyCompletionCodeAction` arguments into a `workspace/applyEdit`
   (or a `WorkspaceEdit` applied directly). This matches what VS Code's Angular
   extension does and unblocks Angular users without touching core semantics.
3. **Give extensions a way to register command handlers**, so a language
   extension (e.g. `zed-angular`) can implement client commands itself instead
   of each user needing a separate workaround.

Option 2 is the smallest and unblocks the most common case (Angular
auto-imports); option 3 is the most future-proof, since other servers also use
client commands for cross-file edits.

## Workaround in use today

A dedicated extension (`angular-prime-ng-autoimport-lsp`) that runs an auxiliary
language server: on `didChange` of an `.html` it detects PrimeNG selectors
(`p-button`, `pTemplate`, …), computes the missing imports for the sibling `.ts`
(using the package's `exports`/`.d.ts` and its NgModule export graph) and applies
them with a client-side `workspace/applyEdit`. It works, but it is a per-framework
reimplementation of what the client should do with the completion it already
receives — every framework with a similar command needs its own workaround.
