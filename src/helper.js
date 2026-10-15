'use strict';
/*
 * Helper LSP do Zed: sincroniza os imports do PrimeNG entre o template Angular
 * (.html) e o componente (.ts).
 *
 * Contexto: o Angular Language Service monta o import corretamente, mas o
 * entrega via o comando proprietario do cliente do VS Code
 * "angular.applyCompletionCodeAction". O LSP nao permite que um item de
 * completion edite outro arquivo (additionalTextEdits vale so para o mesmo
 * documento), e o Zed nao executa esse comando. Resultado: a tag <p-*> entra no
 * HTML, mas o import nunca chega ao .ts.
 *
 * Este helper reproduz o efeito pelo lado do cliente: ao detectar componentes
 * conhecidos do PrimeNG no template, calcula os imports que faltam no
 * componente e os aplica via "workspace/applyEdit".
 *
 * Invocado pelo Zed como:
 *   node -e "<bootstrap>" <base64 deste arquivo> <raiz do worktree>
 */

const fs = require('fs');
const path = require('path');

const WORKTREE_ROOT = process.argv[2] || process.cwd();
const DEBOUNCE_MS = 400;

const options = { autoImportOnChange: true, packageName: 'primeng', debug: false };

let inputBuffer = Buffer.alloc(0);
const documents = new Map();     // uri -> { text, languageId }
const shadows = new Map();       // uri do .ts -> { base, result }
const timers = new Map();        // uri do .html -> debounce
const packageCache = new Map();  // pasta do pacote -> { selectors, moduleExports }
let nextServerRequestId = 1000000;
let clientSupportsApplyEdit = true;

/* ------------------------------- transporte ------------------------------- */

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id: id, result: result === undefined ? null : result });
}

function log(text) {
  if (!options.debug) return;
  try {
    writeMessage({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 4, message: '[prime-ng-autoimport] ' + String(text) },
    });
  } catch (error) {
    /* ignora */
  }
}

/* --------------------------------- URIs ----------------------------------- */

function uriToPath(uri) {
  let value = String(uri).replace(/^file:\/\//i, '');
  if (value.charAt(0) === '/') {
    const rest = value.slice(1);
    if (/^[A-Za-z]:/.test(rest)) value = rest;              // file:///C:/...
    else if (/^[A-Za-z0-9]/.test(rest)) value = '/' + rest; // UNC
  }
  try {
    value = decodeURIComponent(value);
  } catch (error) {
    /* mantem */
  }
  return value.replace(/\//g, path.sep);
}

/*
 * Deriva a URI do .ts irmao reaproveitando o prefixo/codificacao da URI do
 * .html, para nao divergir do que o editor usa internamente.
 */
function siblingTypeScriptUri(uri) {
  const match = /^(.*\/)([^\/]+)\.html$/i.exec(String(uri));
  if (!match) return null;
  return match[1] + match[2] + '.ts';
}

/* --------------------- localizacao do pacote (node_modules) ---------------- */

/*
 * Sobe a partir da pasta do arquivo procurando node_modules/<pacote>, como o
 * resolvedor do Node. Isso cobre tanto projetos simples quanto o caso em que o
 * worktree do Zed e a pasta externa de um repositorio com o app um nivel abaixo.
 */
function resolvePackageDir(fromPath) {
  let directory = path.dirname(fromPath);

  for (;;) {
    const candidate = path.join(directory, 'node_modules', options.packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function typesPathOf(entry) {
  if (typeof entry === 'string') return /\.d\.ts$/.test(entry) ? entry : null;
  if (Array.isArray(entry)) {
    for (let i = 0; i < entry.length; i++) {
      const found = typesPathOf(entry[i]);
      if (found) return found;
    }
    return null;
  }
  if (entry && typeof entry === 'object') {
    if (typeof entry.types === 'string') return entry.types;
    if (typeof entry.default === 'string' && /\.d\.ts$/.test(entry.default)) return entry.default;
  }
  return null;
}

/*
 * Le os argumentos de tipo de uma declaracao a partir do '<', respeitando
 * aninhamento, para lidar com genericos como Table<any>.
 */
function readTypeArguments(text, openIndex) {
  let depth = 0;
  let end = -1;

  for (let i = openIndex; i < text.length; i++) {
    const character = text[i];
    if (character === '<') depth += 1;
    else if (character === '>') {
      depth -= 1;
      if (!depth) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const inner = text.slice(openIndex + 1, end);
  const parts = [];
  let current = '';
  let brackets = 0;

  for (let i = 0; i < inner.length; i++) {
    const character = inner[i];
    if (character === '[' || character === '(' || character === '{') brackets += 1;
    else if (character === ']' || character === ')' || character === '}') brackets -= 1;

    if (character === ',' && !brackets) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/*
 * ɵɵNgModuleDeclaration<Modulo, declaracoes, imports, exports>
 * O 4o argumento lista o que o modulo disponibiliza para o template
 * (ex.: TagModule exporta Tag). Sem isso o helper acharia que <p-tag> precisa
 * de um import novo mesmo com TagModule ja declarado.
 */
function collectModuleExports(text, into) {
  const marker = 'NgModuleDeclaration';
  let index = text.indexOf(marker);

  while (index !== -1) {
    const open = text.indexOf('<', index + marker.length);
    const parts = open === -1 ? null : readTypeArguments(text, open);

    if (parts && parts.length >= 4) {
      const moduleName = parts[0].trim();
      const exported = [];
      const found = parts[3].match(/typeof\s+([A-Za-z0-9_$.]+)/g);

      if (found) {
        for (let i = 0; i < found.length; i++) {
          exported.push(found[i].replace(/^typeof\s+/, '').split('.').pop());
        }
      }
      if (moduleName && exported.length && !into.has(moduleName)) {
        into.set(moduleName, exported);
      }
    }
    index = text.indexOf(marker, index + marker.length);
  }
}

/*
 * Monta seletor -> { classe, modulo } a partir dos .d.ts do pacote:
 * ɵɵComponentDeclaration<Button, "p-button"
 */
function buildPackageInfo(packageDir) {
  const selectors = new Map();
  const moduleExports = new Map();

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch (error) {
    log('nao consegui ler o package.json de ' + packageDir);
    return { selectors: selectors, moduleExports: moduleExports };
  }

  const entries = manifest.exports || {};
  for (const key of Object.keys(entries)) {
    if (key.indexOf('./') !== 0 || key === './package.json') continue;
    const typesPath = typesPathOf(entries[key]);
    if (!typesPath) continue;

    let declarations;
    try {
      declarations = fs.readFileSync(path.join(packageDir, typesPath), 'utf8');
    } catch (error) {
      continue;
    }

    const specifier = options.packageName + '/' + key.slice(2);
    const declaration = /ɵɵ(?:Component|Directive)Declaration<\s*([A-Za-z0-9_$]+)(?:<[^,<>]*>)?\s*,\s*"([^"]+)"/g;
    let match;

    while ((match = declaration.exec(declarations))) {
      const selectorsInDeclaration = match[2].split(',');
      for (let i = 0; i < selectorsInDeclaration.length; i++) {
        const selector = selectorsInDeclaration[i].trim();
        if (selector && !selectors.has(selector)) {
          selectors.set(selector, { className: match[1], specifier: specifier });
        }
      }
    }

    collectModuleExports(declarations, moduleExports);
  }

  log('mapa de ' + packageDir + ': ' + selectors.size + ' seletores, '
    + moduleExports.size + ' modulos');
  return { selectors: selectors, moduleExports: moduleExports };
}

function packageInfoFor(fromPath) {
  const packageDir = resolvePackageDir(fromPath);
  if (!packageDir) {
    log('pacote "' + options.packageName + '" nao encontrado a partir de ' + fromPath);
    return null;
  }
  if (!packageCache.has(packageDir)) packageCache.set(packageDir, buildPackageInfo(packageDir));
  return packageCache.get(packageDir);
}

/*
 * Expande o conteudo de imports: [...] para tudo que ele disponibiliza no
 * template, seguindo os exports dos modulos.
 */
function expandAvailable(names, moduleExports) {
  const available = new Set();

  const visit = function (name, seen) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    available.add(name);

    const exported = moduleExports.get(name);
    if (exported) {
      for (let i = 0; i < exported.length; i++) visit(exported[i], seen);
    }
  };

  for (let i = 0; i < names.length; i++) visit(names[i], new Set());
  return available;
}

/* --------------------- dependencias usadas no template -------------------- */

function unwrapAttribute(name) {
  return name.replace(/^\[\(?/, '').replace(/\)?\]$/, '');
}

function dependenciesInTemplate(text, info) {
  const found = new Map();
  if (!info || typeof text !== 'string') return found;

  const add = function (name) {
    const dependency = info.selectors.get(name);
    if (dependency) found.set(dependency.className, dependency);
  };

  const regions = /<([^<>]*)>/g;
  let region;
  while ((region = regions.exec(text))) {
    const inner = region[1];
    if (/^\s*[\/!?]/.test(inner)) continue;   // fechamento, comentario, doctype

    const tagName = /^\s*([A-Za-z][A-Za-z0-9:_.-]*)/.exec(inner);
    if (tagName) add(tagName[1]);

    const attributes = inner.match(/[\s]([A-Za-z][A-Za-z0-9:_.-]*)/g);
    if (attributes) {
      for (let i = 0; i < attributes.length; i++) add(unwrapAttribute(attributes[i].trim()));
    }
  }

  return found;
}

/* ------------------------------- editar .ts ------------------------------- */

function parseImportStatements(text) {
  const statements = [];
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;
  let match;

  while ((match = pattern.exec(text))) {
    const inner = match[1];
    const innerStart = match.index + match[0].indexOf('{') + 1;
    const names = [];
    const namePattern = /([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?/g;
    let nameMatch;

    while ((nameMatch = namePattern.exec(inner))) {
      names.push({
        name: nameMatch[1],
        local: nameMatch[2] || nameMatch[1],
        start: innerStart + nameMatch.index,
        end: innerStart + nameMatch.index + nameMatch[0].length,
      });
    }

    statements.push({
      start: match.index,
      end: match.index + match[0].length,
      innerStart: innerStart,
      innerEnd: innerStart + inner.length,
      specifier: match[3],
      names: names,
    });
  }

  return statements;
}

function positionMapper(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  return function (offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: offset - lineStarts[low] };
  };
}

function offsetOf(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset + position.character;
}

function applyEditsToText(text, edits) {
  const items = edits.map(function (edit) {
    return {
      start: offsetOf(text, edit.range.start),
      end: offsetOf(text, edit.range.end),
      newText: edit.newText,
    };
  });
  items.sort(function (a, b) { return b.start - a.start; });

  let result = text;
  for (let i = 0; i < items.length; i++) {
    result = result.slice(0, items[i].start) + items[i].newText + result.slice(items[i].end);
  }
  return result;
}

/*
 * Calcula os text edits necessarios no componente .ts para os componentes
 * usados no template. Retorna null quando nada falta.
 */
function computeEdits(tsText, dependencies, moduleExports) {
  if (!dependencies.size) return null;
  if (!/@Component\s*\(/.test(tsText)) return null;

  const arrayMatch = /\bimports\s*:\s*\[([^\]]*)\]/.exec(tsText);
  if (!arrayMatch) return null;

  const imports = parseImportStatements(tsText);
  const arrayInner = arrayMatch[1];
  const arrayInnerStart = arrayMatch.index + arrayMatch[0].indexOf('[') + 1;

  const present = new Set();
  for (let i = 0; i < imports.length; i++) {
    for (let j = 0; j < imports[i].names.length; j++) present.add(imports[i].names[j].name);
  }

  const listed = arrayInner.split(',')
    .map(function (item) { return item.trim(); })
    .filter(Boolean);

  // O template ja alcanca a classe se ela propria esta listada ou se algum
  // modulo listado em imports: [...] a exporta (ex.: TagModule exporta Tag).
  const available = expandAvailable(listed, moduleExports);

  const missing = [];
  dependencies.forEach(function (dependency) {
    if (available.has(dependency.className)) return;
    missing.push({
      className: dependency.className,
      specifier: dependency.specifier,
      needsImport: !present.has(dependency.className),
    });
  });
  if (!missing.length) return null;

  const edits = [];
  const positionAt = positionMapper(tsText);
  const addEdit = function (start, end, newText) {
    edits.push({ range: { start: positionAt(start), end: positionAt(end) }, newText: newText });
  };

  // 1) linhas de import (agrupadas por modulo, reaproveitando imports existentes)
  const bySpecifier = new Map();
  for (let i = 0; i < missing.length; i++) {
    const dependency = missing[i];
    if (!dependency.needsImport) continue;
    if (!bySpecifier.has(dependency.specifier)) bySpecifier.set(dependency.specifier, []);
    bySpecifier.get(dependency.specifier).push(dependency.className);
  }

  const newStatements = [];
  bySpecifier.forEach(function (classNames, specifier) {
    const existing = imports.filter(function (statement) {
      return statement.specifier === specifier;
    })[0];

    if (existing) {
      const inner = tsText.slice(existing.innerStart, existing.innerEnd);
      if (!inner.trim()) {
        addEdit(existing.innerStart, existing.innerEnd, ' ' + classNames.join(', ') + ' ');
      } else {
        const last = existing.names[existing.names.length - 1];
        addEdit(last.end, last.end, ', ' + classNames.join(', '));
      }
    } else {
      newStatements.push("import { " + classNames.join(', ') + " } from '" + specifier + "';");
    }
  });

  if (newStatements.length) {
    const anchor = imports.length ? imports[imports.length - 1].end : 0;
    addEdit(anchor, anchor, newStatements.map(function (line) { return '\n' + line; }).join(''));
  }

  // 2) nomes dentro de imports: [...] do @Component
  const allNames = listed.concat(missing.map(function (dependency) { return dependency.className; }));
  let newInner;

  if (arrayInner.indexOf('\n') === -1) {
    newInner = allNames.join(', ');
  } else {
    const indentMatch = /\n([ \t]*)\S/.exec(arrayInner);
    const indent = indentMatch ? indentMatch[1] : '  ';
    const closingMatch = /\n([ \t]*)$/.exec(arrayInner);
    const closing = closingMatch ? closingMatch[1] : '';
    newInner = '\n' + allNames.map(function (name) { return indent + name; }).join(',\n') + '\n' + closing;
  }

  addEdit(arrayInnerStart, arrayInnerStart + arrayInner.length, newInner);

  return { edits: edits, added: missing.length };
}

/* ------------------------------ estado do .ts ----------------------------- */

function readFromDisk(uri) {
  try {
    return fs.readFileSync(uriToPath(uri), 'utf8');
  } catch (error) {
    return null;
  }
}

/*
 * Texto corrente do .ts: o buffer do editor quando disponivel, senao o disco.
 * A "sombra" cobre o caso em que o Zed aplicou uma edicao que ainda nao foi
 * gravada nem reportada de volta.
 */
function currentText(uri) {
  if (documents.has(uri)) return documents.get(uri).text;

  const disk = readFromDisk(uri);
  const shadow = shadows.get(uri);
  if (shadow && disk === shadow.base) return shadow.result;
  if (shadow) shadows.delete(uri);
  return disk;
}

function collectPending(uri) {
  if (!/\.html$/i.test(uri)) return null;

  const htmlText = documents.has(uri) ? documents.get(uri).text : readFromDisk(uri);
  if (typeof htmlText !== 'string') return null;

  const tsUri = siblingTypeScriptUri(uri);
  if (!tsUri) return null;

  const tsPath = uriToPath(tsUri);
  const info = packageInfoFor(tsPath);
  if (!info) return null;

  const tsText = currentText(tsUri);
  if (typeof tsText !== 'string') return null;

  const dependencies = dependenciesInTemplate(htmlText, info);
  const result = computeEdits(tsText, dependencies, info.moduleExports);
  if (!result) return null;

  return { tsUri: tsUri, tsText: tsText, edits: result.edits, added: result.added };
}

function changesFor(result) {
  const changes = {};
  changes[result.tsUri] = result.edits;
  return changes;
}

function applyPending(uri, reason) {
  const result = collectPending(uri);
  if (!result) return;

  if (!clientSupportsApplyEdit) {
    log('cliente nao suporta workspace/applyEdit; nada aplicado (' + reason + ')');
    return;
  }

  log('+' + result.added + ' import(s) em ' + result.tsUri + ' (' + reason + ')');
  shadows.set(result.tsUri, {
    base: result.tsText,
    result: applyEditsToText(result.tsText, result.edits),
  });

  nextServerRequestId += 1;
  writeMessage({
    jsonrpc: '2.0',
    id: nextServerRequestId,
    method: 'workspace/applyEdit',
    params: { label: 'PrimeNG: add imports', edit: { changes: changesFor(result) } },
  });
}

function schedule(uri) {
  const pending = timers.get(uri);
  if (pending) clearTimeout(pending);
  timers.set(uri, setTimeout(function () {
    timers.delete(uri);
    try {
      applyPending(uri, 'didChange');
    } catch (error) {
      log('falha ao aplicar: ' + error.message);
    }
  }, DEBOUNCE_MS));
}

/* ---------------------------------- LSP ----------------------------------- */

function handleInitialize(message) {
  const params = message.params || {};
  const capabilities = params.capabilities || {};
  clientSupportsApplyEdit = !!(capabilities.workspace && capabilities.workspace.applyEdit);

  const provided = params.initializationOptions;
  if (provided && typeof provided === 'object') {
    if (typeof provided.autoImportOnChange === 'boolean') options.autoImportOnChange = provided.autoImportOnChange;
    if (typeof provided.package === 'string') options.packageName = provided.package;
    if (typeof provided.debug === 'boolean') options.debug = provided.debug;
  }

  log('iniciado. worktree=' + WORKTREE_ROOT + ' autoImportOnChange=' + options.autoImportOnChange
    + ' applyEdit=' + clientSupportsApplyEdit);

  respond(message.id, {
    capabilities: {
      textDocumentSync: { openClose: true, change: 1 },
      codeActionProvider: { codeActionKinds: ['quickfix'] },
    },
    serverInfo: { name: 'angular-prime-ng-autoimport-lsp', version: '0.1.0' },
  });
}

function handleMessage(message) {
  const method = message.method;
  const params = message.params || {};

  // #### RESPOSTA DO PING TEMPORARIO ####
  if (method === undefined && message.id !== undefined && message.id > 1000000) {
    process.stderr.write('[prime-ng-autoimport] PING applyEdit -> '
      + JSON.stringify(message.result !== undefined ? message.result : message.error) + '\n');
    return;
  }
  // #### FIM ####

  if (method === 'initialize') return handleInitialize(message);
  if (method === 'initialized') return;
  if (method === 'shutdown') return respond(message.id, null);
  if (method === 'exit') return process.exit(0);

  if (method === 'textDocument/didOpen') {
    const document = params.textDocument;
    documents.set(document.uri, { text: document.text, languageId: document.languageId });
    return;
  }

  if (method === 'textDocument/didChange') {
    const uri = params.textDocument.uri;
    const changes = params.contentChanges || [];
    if (changes.length) {
      const previous = documents.get(uri);
      documents.set(uri, {
        text: changes[changes.length - 1].text,
        languageId: previous ? previous.languageId : undefined,
      });
      if (options.autoImportOnChange) schedule(uri);
    }
    return;
  }

  if (method === 'textDocument/didClose') {
    documents.delete(params.textDocument.uri);
    shadows.delete(params.textDocument.uri);
    return;
  }

  if (method === 'textDocument/codeAction') {
    const uri = params.textDocument.uri;
    let actions = [];

    try {
      const result = collectPending(uri);
      if (result && clientSupportsApplyEdit) {
        actions = [{
          title: 'PrimeNG: add import' + (result.added > 1 ? 's' : '') + ' (' + result.added + ')',
          kind: 'quickfix',
          edit: { changes: changesFor(result) },
        }];
      }
    } catch (error) {
      log('falha no code action: ' + error.message);
    }

    return respond(message.id, actions);
  }

  // Qualquer outra requisicao precisa de resposta para nao travar o editor.
  if (message.id !== undefined && method) return respond(message.id, null);
}

/* --------------------------------- entrada -------------------------------- */

process.stdin.on('data', function (chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  for (;;) {
    const separator = inputBuffer.indexOf('\r\n\r\n');
    if (separator === -1) return;

    const header = inputBuffer.slice(0, separator).toString('ascii');
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      inputBuffer = inputBuffer.slice(separator + 4);
      continue;
    }

    const length = Number(lengthMatch[1]);
    if (inputBuffer.length < separator + 4 + length) return;

    const raw = inputBuffer.slice(separator + 4, separator + 4 + length).toString('utf8');
    inputBuffer = inputBuffer.slice(separator + 4 + length);

    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      continue;
    }

    try {
      handleMessage(message);
    } catch (error) {
      process.stderr.write('[prime-ng-autoimport] ' + error.stack + '\n');
    }
  }
});

process.stdin.on('end', function () { process.exit(0); });
process.on('uncaughtException', function (error) {
  process.stderr.write('[prime-ng-autoimport] ' + error.stack + '\n');
});
