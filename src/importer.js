import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as actual from '@actual-app/api';

const INBOX = '/inbox';
const PROCESSED = '/processed';
const FAILED = '/failed';
const CONFIG_PATH = '/app/config.json';
const MAPPING_PATH = '/app/mapping.json';

const SERVER_URL = process.env.ACTUAL_SERVER_URL;
const SYNC_ID = process.env.ACTUAL_SYNC_ID;
const PASSWORD_FILE = process.env.ACTUAL_PASSWORD_FILE;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const CATEGORIZE_EXISTING = process.env.CATEGORIZE_EXISTING === 'true';

const POLL_INTERVAL_MS = 30_000;

// ============================================================
// Utils
// ============================================================

async function readSecret(file) {
  const value = await fs.readFile(file, 'utf8');
  return value.trim();
}

function cents(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`Importe inválido: ${value}`);
  }

  return Math.round(number * 100);
}

function formatMoney(value) {
  return `${(value / 100).toFixed(2)} €`;
}

function normalizeDate(day, month, year) {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function dateDifferenceDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);

  const aDate = Date.UTC(ay, am - 1, ad);
  const bDate = Date.UTC(by, bm - 1, bd);

  return Math.abs((aDate - bDate) / 86400000);
}

function normalizeText(value) {
  if (!value) {
    return '';
  }

  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// Optional category mapping
// ============================================================

async function loadMapping() {
  try {
    const content = await fs.readFile(MAPPING_PATH, 'utf8');
    const mapping = JSON.parse(content);

    if (!Array.isArray(mapping.rules)) {
      throw new Error('"rules" debe ser una lista');
    }

    return mapping.rules.map((rule, index) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`Regla ${index + 1}: debe ser un objeto`);
      }

      if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
        throw new Error(`Regla ${index + 1}: "pattern" es obligatorio`);
      }

      if (typeof rule.categoryGroup !== 'string' || !rule.categoryGroup) {
        throw new Error(`Regla ${index + 1}: "categoryGroup" es obligatorio`);
      }

      if (typeof rule.category !== 'string' || !rule.category) {
        throw new Error(`Regla ${index + 1}: "category" es obligatorio`);
      }

      const priority = rule.priority ?? 0;

      if (!Number.isFinite(priority)) {
        throw new Error(`Regla ${index + 1}: "priority" debe ser un número`);
      }

      if (rule.flags !== undefined && typeof rule.flags !== 'string') {
        throw new Error(`Regla ${index + 1}: "flags" debe ser texto`);
      }

      try {
        // Compile now so an invalid local mapping fails before any import.
        new RegExp(rule.pattern, rule.flags ?? 'i');
      } catch (error) {
        throw new Error(`Regla ${index + 1}: regex inválida: ${error.message}`);
      }

      return {
        name: rule.name || `Regla ${index + 1}`,
        pattern: rule.pattern,
        flags: rule.flags ?? 'i',
        priority,
        categoryGroup: rule.categoryGroup,
        category: rule.category,
        index,
      };
    }).sort((a, b) => b.priority - a.priority || a.index - b.index);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`No se encontró ${MAPPING_PATH}; se importará sin categorías.`);
      return [];
    }

    throw new Error(`No se pudo cargar ${MAPPING_PATH}: ${error.message}`);
  }
}

async function resolveMappingCategories(rules) {
  if (rules.length === 0) {
    return new Map();
  }

  const [groups, categories] = await Promise.all([
    actual.getCategoryGroups(),
    actual.getCategories(),
  ]);

  const groupsByName = new Map(
    groups.map((group) => [normalizeText(group.name), group]),
  );
  const categoriesByGroupAndName = new Map(
    categories.map((category) => [
      `${category.group_id}:${normalizeText(category.name)}`,
      category,
    ]),
  );
  const resolved = new Map();

  for (const rule of rules) {
    const group = groupsByName.get(normalizeText(rule.categoryGroup));

    if (!group) {
      console.warn(
        `⚠ Regla "${rule.name}" ignorada: no existe el grupo ` +
          `"${rule.categoryGroup}" en Actual.`,
      );
      continue;
    }

    const category = categoriesByGroupAndName.get(
      `${group.id}:${normalizeText(rule.category)}`,
    );

    if (!category) {
      console.warn(
        `⚠ Regla "${rule.name}" ignorada: no existe la categoría ` +
          `"${rule.categoryGroup}" / "${rule.category}" en Actual.`,
      );
      continue;
    }

    resolved.set(rule, category.id);
  }

  return resolved;
}

function getMappingSearchText(source) {
  return normalizeText(
    [source.concept, source.reference, source.locality, source.nif]
      .filter(Boolean)
      .join(' '),
  );
}

function getCategoryForTransaction(source, rules, resolvedCategories) {
  const searchText = getMappingSearchText(source);

  for (const rule of rules) {
    const categoryId = resolvedCategories.get(rule);

    if (!categoryId) {
      continue;
    }

    // A fresh RegExp avoids state leaking from a user-provided global flag.
    if (new RegExp(rule.pattern, rule.flags).test(searchText)) {
      return {
        id: categoryId,
        name: rule.name,
        category: rule.category,
        categoryGroup: rule.categoryGroup,
      };
    }
  }

  return null;
}

async function categorizeExistingTransactions(
  results,
  accountConfig,
  mappingRules,
  resolvedCategories,
) {
  const changes = [];

  for (const item of results) {
    if (item.status !== 'EXISTS') {
      continue;
    }

    const transaction = item.actual;

    // Do not overwrite the user's work, alter split transactions, or touch
    // transfers. Existing transactions must be uncategorized and matched
    // unambiguously by compareTransactions before reaching this point.
    if (
      transaction.category ||
      transaction.transfer_id ||
      transaction.is_parent ||
      transaction.is_child ||
      isTransferTransaction(item.source, accountConfig)
    ) {
      continue;
    }

    const category = getCategoryForTransaction(
      item.source,
      mappingRules,
      resolvedCategories,
    );

    if (category) {
      changes.push({ transaction, category, source: item.source });
    }
  }

  if (changes.length === 0) {
    console.log('No hay transacciones existentes sin categoría que actualizar.');
    return 0;
  }

  console.log('');
  console.log(
    `${DRY_RUN ? 'Se categorizarían' : 'Categorizando'} ` +
      `${changes.length} transacción(es) existentes:`,
  );

  for (const change of changes) {
    console.log(
      `  ${change.transaction.date} | ` +
        `${formatMoney(Number(change.transaction.amount))} | ` +
        `${change.source.concept} | ` +
        `${change.category.categoryGroup} / ${change.category.category}`,
    );
  }

  if (DRY_RUN) {
    return changes.length;
  }

  for (const change of changes) {
    await actual.updateTransaction(change.transaction.id, {
      category: change.category.id,
    });
  }

  return changes.length;
}

// ============================================================
// Stable imported ID
// ============================================================

function stableImportedId(transaction) {
  const raw = [
    transaction.operationDate,
    transaction.valueDate,
    transaction.amountCents,
    transaction.balanceCents,
    transaction.concept,
    transaction.nif,
    transaction.reference,
  ].join('|');

  return `sabadell:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

// ============================================================
// Sabadell parser
// ============================================================

function parseSabadell(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const transactions = [];

  for (let i = 0; i < lines.length; i++) {
    const columns = lines[i].split('|');

    if (columns.length !== 7) {
      throw new Error(
        `Línea ${i + 1}: se esperaban 7 columnas, encontradas ${columns.length}`,
      );
    }

    const [
      operationDateRaw,
      concept,
      valueDateRaw,
      amountRaw,
      balanceRaw,
      nif,
      reference,
    ] = columns;

    const operationMatch = operationDateRaw.match(
      /^(\d{2})\/(\d{2})\/(\d{4})$/,
    );

    const valueMatch = valueDateRaw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!operationMatch) {
      throw new Error(
        `Línea ${i + 1}: fecha de operación inválida: ${operationDateRaw}`,
      );
    }

    if (!valueMatch) {
      throw new Error(`Línea ${i + 1}: fecha valor inválida: ${valueDateRaw}`);
    }

    const operationDate = normalizeDate(
      operationMatch[1],
      operationMatch[2],
      operationMatch[3],
    );

    const valueDate = normalizeDate(
      valueMatch[1],
      valueMatch[2],
      valueMatch[3],
    );

    const amountCents = cents(amountRaw);
    const balanceCents = cents(balanceRaw);

    transactions.push({
      operationDate,
      valueDate,
      amountCents,
      balanceCents,
      concept,
      nif,
      reference,

      importedId: stableImportedId({
        operationDate,
        valueDate,
        amountCents,
        balanceCents,
        concept,
        nif,
        reference,
      }),
    });
  }

  if (transactions.length === 0) {
    throw new Error('El CSV no contiene transacciones');
  }

  return transactions;
}

// ============================================================
// Sabadell Card parser
// ============================================================

function getYearFromCardFilename(filePath) {
  const filename = path.basename(filePath);

  const match = filename.match(/(\d{2})(\d{2})(20\d{2})/);

  if (!match) {
    throw new Error(
      `No se pudo determinar el año del fichero de tarjeta: ${filename}`,
    );
  }

  return match[3];
}

function parseCardAmount(value) {
  const normalized = value
    .replace('EUR', '')
    .trim()
    .replace(/\./g, '')
    .replace(',', '.');

  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    throw new Error(`Importe de tarjeta inválido: ${value}`);
  }

  return Math.round(number * 100);
}

function parseSabadellCard(content, filePath) {
  const year = getYearFromCardFilename(filePath);

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const transactions = [];

  for (let i = 0; i < lines.length; i++) {
    const columns = lines[i].split('|');

    // Cabeceras y metadatos
    if (columns.length !== 4 || !/^\d{2}\/\d{2}$/.test(columns[0])) {
      continue;
    }

    const [dateRaw, concept, locality, amountRaw] = columns;

    const dateMatch = dateRaw.match(/^(\d{2})\/(\d{2})$/);

    if (!dateMatch) {
      throw new Error(`Línea ${i + 1}: fecha de tarjeta inválida: ${dateRaw}`);
    }

    const date = `${year}-${dateMatch[2]}-${dateMatch[1]}`;

    // En el extracto de tarjeta:
    // +302,00 EUR = gasto -> -302,00 € en Actual
    // -19,56 EUR = devolución -> +19,56 € en Actual
    const statementAmountCents = parseCardAmount(amountRaw);

    const amountCents = -statementAmountCents;

    const rawForId = [date, concept, locality, statementAmountCents].join('|');

    const importedId = `sabadell-card:${crypto
      .createHash('sha256')
      .update(rawForId)
      .digest('hex')}`;

    transactions.push({
      operationDate: date,
      valueDate: date,
      amountCents,
      concept,
      locality,
      nif: '',
      reference: '',

      importedId,
    });
  }

  if (transactions.length === 0) {
    throw new Error('El TXT de tarjeta no contiene transacciones');
  }

  return transactions;
}

// ============================================================
// Revolut personal account TSV parser
// ============================================================

function parseRevolutAmount(value, field, lineNumber) {
  const amount = Number(value.trim().replace(',', '.'));

  if (!Number.isFinite(amount)) {
    throw new Error(`Línea ${lineNumber}: ${field} de Revolut inválido: ${value}`);
  }

  return Math.round(amount * 100);
}

function parseRevolutDate(value, field, lineNumber) {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2}) \d{1,2}:\d{2}:\d{2}$/);

  if (!match) {
    throw new Error(`Línea ${lineNumber}: ${field} de Revolut inválida: ${value}`);
  }

  return match[1];
}

function parseRevolutAccountStatement(content, expectedCurrency = 'EUR') {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 2) {
    throw new Error('El TSV de Revolut no contiene transacciones');
  }

  const header = lines[0].split('\t').map((value) => normalizeText(value));

  if (
    header.length !== 10 ||
    header[0] !== 'tipo' ||
    header[1] !== 'producto' ||
    header[2] !== 'fecha de inicio' ||
    !header[3].startsWith('fecha de finaliz') ||
    !header[4].startsWith('descripci') ||
    header[5] !== 'importe' ||
    !header[6].startsWith('comisi') ||
    header[7] !== 'divisa' ||
    header[8] !== 'state' ||
    header[9] !== 'saldo'
  ) {
    throw new Error('Cabecera TSV de Revolut no reconocida');
  }

  const transactions = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const columns = lines[i].split('\t');

    if (columns.length !== 10) {
      throw new Error(
        `Línea ${lineNumber}: se esperaban 10 columnas, encontradas ${columns.length}`,
      );
    }

    const [
      type,
      product,
      startedAt,
      completedAt,
      description,
      amountRaw,
      feeRaw,
      currency,
      state,
      balanceRaw,
    ] = columns.map((value) => value.trim());

    if (currency !== expectedCurrency) {
      throw new Error(
        `Línea ${lineNumber}: divisa de Revolut inesperada: ${currency} ` +
          `(se esperaba ${expectedCurrency})`,
      );
    }

    // Reverted card payments have no completed date or final balance. They
    // must not create an expense in Actual.
    if (state !== 'COMPLETADO') {
      continue;
    }

    const operationDate = parseRevolutDate(startedAt, 'fecha de inicio', lineNumber);
    const valueDate = parseRevolutDate(
      completedAt,
      'fecha de finalización',
      lineNumber,
    );
    const amountCents = parseRevolutAmount(amountRaw, 'importe', lineNumber);
    const feeCents = parseRevolutAmount(feeRaw, 'comisión', lineNumber);
    const balanceCents = parseRevolutAmount(balanceRaw, 'saldo', lineNumber);

    // Revolut reports fees as positive values. They reduce the balance in
    // addition to the transaction amount and need to be imported too.
    const netAmountCents = amountCents - feeCents;
    const rawForId = [
      type,
      product,
      startedAt,
      completedAt,
      description,
      amountRaw,
      feeRaw,
      currency,
      state,
      balanceRaw,
    ].join('\t');

    transactions.push({
      operationDate,
      valueDate,
      amountCents: netAmountCents,
      balanceCents,
      concept: description,
      nif: '',
      reference: `${type} / ${product}`,
      importedId: `revolut:${crypto
        .createHash('sha256')
        .update(rawForId)
        .digest('hex')}`,
    });
  }

  if (transactions.length === 0) {
    throw new Error('El TSV de Revolut no contiene transacciones completadas');
  }

  return transactions;
}

// ============================================================
// Parser dispatcher
// ============================================================

function parseFile(parserName, content, filePath, accountConfig) {
  switch (parserName) {
    case 'sabadell':
      return parseSabadell(content);

    case 'sabadell-card':
      return parseSabadellCard(content, filePath);

    case 'revolut':
      return parseRevolutAccountStatement(
        content,
        accountConfig.currency ?? 'EUR',
      );

    default:
      throw new Error(`Parser desconocido: ${parserName}`);
  }
}

// ============================================================
// Find transaction files
// ============================================================

async function findTransactionFiles(dir) {
  const result = [];

  async function walk(current) {
    const entries = await fs.readdir(current, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        ['.csv', '.tsv', '.txt'].some((extension) =>
          entry.name.toLowerCase().endsWith(extension),
        )
      ) {
        result.push(fullPath);
      }
    }
  }

  await walk(dir);

  return result.sort();
}

// ============================================================
// Account detection
// ============================================================

function getAccountConfig(filePath, config) {
  const relative = path.relative(INBOX, filePath);
  const parts = relative.split(path.sep);

  if (parts.length < 3) {
    throw new Error(`El fichero debe estar dentro de /inbox/<banco>/<cuenta>/`);
  }

  const bank = parts[0];
  const account = parts[1];

  const key = `${bank}/${account}`;

  const accountConfig = config.accounts[key];

  if (!accountConfig) {
    throw new Error(`No existe configuración para la cuenta: ${key}`);
  }

  return {
    key,
    bank,
    account,
    ...accountConfig,
  };
}

// ============================================================
// Actual Budget
// ============================================================

async function loadActual() {
  const password = await readSecret(PASSWORD_FILE);

  await actual.init({
    serverURL: SERVER_URL,
    password,
  });

  await actual.downloadBudget(SYNC_ID);
}

async function getExistingTransactions(accountId) {
  return await actual.getTransactions(accountId, '2000-01-01', '2100-12-31');
}

// ============================================================
// Extract text from Actual transaction
// ============================================================

function getActualSearchText(transaction) {
  return normalizeText(
    [
      transaction.payee_name,
      transaction.payee,
      transaction.notes,
      transaction.imported_payee,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

// ============================================================
// Check imported_id
// ============================================================

function hasMatchingImportedId(source, actualTransactions) {
  return actualTransactions.find(
    (transaction) =>
      transaction.imported_id && transaction.imported_id === source.importedId,
  );
}

function sourceComparisonKey(source) {
  return [
    source.operationDate,
    source.amountCents,
    normalizeText(source.concept),
    normalizeText(source.reference),
  ].join('|');
}

function countDuplicateSources(sourceTransactions) {
  const counts = new Map();

  for (const source of sourceTransactions) {
    const key = sourceComparisonKey(source);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

// ============================================================
// Candidate scoring
// ============================================================

function scoreCandidate(source, candidate) {
  let score = 0;

  const dateDiff = dateDifferenceDays(source.operationDate, candidate.date);

  // Amount is mandatory and is checked before this function.
  score += 100;

  // Exact date is significantly stronger than ±1 day.
  if (dateDiff === 0) {
    score += 50;
  } else if (dateDiff === 1) {
    score += 20;
  }

  const actualText = getActualSearchText(candidate);

  const concept = normalizeText(source.concept);

  const reference = normalizeText(source.reference);

  if (
    concept &&
    actualText &&
    (actualText.includes(concept) || concept.includes(actualText))
  ) {
    score += 40;
  }

  if (reference && actualText && actualText.includes(reference)) {
    score += 60;
  }

  return score;
}

// ============================================================
// Comparator
// ============================================================

function compareTransactions(
  sourceTransactions,
  actualTransactions,
  toleranceDays,
) {
  const results = [];

  // Keep track of Actual transactions already matched
  // by this CSV. This prevents two source rows from
  // accidentally matching the same Actual transaction.
  const usedActualIds = new Set();
  const duplicateSourceCounts = countDuplicateSources(sourceTransactions);

  for (const source of sourceTransactions) {
    // --------------------------------------------------------
    // 1. Strongest possible match: imported_id
    // --------------------------------------------------------

    const importedIdMatch = hasMatchingImportedId(source, actualTransactions);

    if (importedIdMatch && !usedActualIds.has(importedIdMatch.id)) {
      usedActualIds.add(importedIdMatch.id);

      results.push({
        status: 'EXISTS',
        method: 'IMPORTED_ID',
        source,
        actual: importedIdMatch,
      });

      continue;
    }

    // --------------------------------------------------------
    // 2. Candidate search by amount + date
    // --------------------------------------------------------

    const candidates = actualTransactions
      .filter((actualTx) => {
        if (usedActualIds.has(actualTx.id)) {
          return false;
        }

        if (Number(actualTx.amount) !== source.amountCents) {
          return false;
        }

        if (!actualTx.date) {
          return false;
        }

        return (
          dateDifferenceDays(source.operationDate, actualTx.date) <=
          toleranceDays
        );
      })
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(source, candidate),
      }))
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));

    // --------------------------------------------------------
    // 3. No candidate
    // --------------------------------------------------------

    if (candidates.length === 0) {
      results.push({
        status: 'NEW',
        source,
      });

      continue;
    }

    // Some bank exports contain genuinely separate operations with identical
    // date, amount, concept and reference. They can be told apart by their
    // running balance, which does not exist in Actual. Pair them only when
    // both sides have exactly the same multiplicity and every match is exact.
    const duplicateSourceCount = duplicateSourceCounts.get(
      sourceComparisonKey(source),
    );

    if (
      duplicateSourceCount > 1 &&
      candidates.length === duplicateSourceCount &&
      candidates.every(
        (item) =>
          item.candidate.date === source.operationDate && item.score >= 250,
      )
    ) {
      const match = candidates[0].candidate;

      usedActualIds.add(match.id);

      results.push({
        status: 'EXISTS',
        method: 'DUPLICATE_EXACT',
        source,
        actual: match,
      });

      continue;
    }

    // --------------------------------------------------------
    // 4. Candidate with a unique strong score
    // --------------------------------------------------------

    if (candidates.length === 1) {
      const match = candidates[0].candidate;

      usedActualIds.add(match.id);

      results.push({
        status: 'EXISTS',
        method: 'AMOUNT_DATE',
        source,
        actual: match,
      });

      continue;
    }

    const best = candidates[0];
    const second = candidates[1];

    // If the best candidate is clearly better than
    // the second candidate, accept it.
    //
    // Otherwise we deliberately refuse to guess.
    if (best.score > second.score && best.score >= 150) {
      usedActualIds.add(best.candidate.id);

      results.push({
        status: 'EXISTS',
        method: 'SCORED',
        source,
        actual: best.candidate,
      });

      continue;
    }

    // --------------------------------------------------------
    // 5. Ambiguous
    // --------------------------------------------------------

    results.push({
      status: 'AMBIGUOUS',
      source,
      candidates: candidates.map((item) => ({
        ...item.candidate,
        matchScore: item.score,
      })),
    });
  }

  return results;
}

function isTransferTransaction(source, accountConfig) {
  const transfer = accountConfig.transfer;

  if (!transfer) {
    return false;
  }

  const conceptMatches =
    normalizeText(source.concept) === normalizeText(transfer.concept);

  const referenceMatches =
    normalizeText(source.reference) === normalizeText(transfer.reference);

  return conceptMatches && referenceMatches;
}

// ============================================================
// Convert to Actual transaction
// ============================================================

function toActualTransaction(source, transferPayeeId = null, category = null) {
  const isTransfer = Boolean(transferPayeeId);

  if (isTransfer) {
    return {
      date: source.operationDate,

      amount: source.amountCents,

      payee: transferPayeeId,

      imported_payee: source.concept || undefined,

      notes:
        [
          source.reference ? `Referencia: ${source.reference}` : null,

          source.nif ? `NIF/CIF: ${source.nif}` : null,
        ]
          .filter(Boolean)
          .join('\n') || undefined,

      imported_id: source.importedId,
    };
  }

  return {
    date: source.operationDate,

    amount: source.amountCents,

    payee_name: source.concept || undefined,

    imported_payee: source.concept || undefined,

    notes:
      [
        source.locality ? `Localidad: ${source.locality}` : null,

        source.reference ? `Referencia: ${source.reference}` : null,

        source.nif ? `NIF/CIF: ${source.nif}` : null,
      ]
        .filter(Boolean)
        .join('\n') || undefined,

    imported_id: source.importedId,

    category: category?.id,
  };
}

// ============================================================
// Safe file moving
// ============================================================

async function moveUnique(sourcePath, destinationDir) {
  await fs.mkdir(destinationDir, {
    recursive: true,
  });

  const filename = path.basename(sourcePath);

  const extension = path.extname(filename);

  const basename = path.basename(filename, extension);

  let destination = path.join(destinationDir, filename);

  let counter = 1;

  while (true) {
    try {
      await fs.access(destination);

      destination = path.join(
        destinationDir,
        `${basename}-${counter}${extension}`,
      );

      counter++;
    } catch {
      break;
    }
  }

  // Different Docker bind mounts can cause EXDEV with rename().
  // Copy first, verify, then delete the original.

  await fs.copyFile(sourcePath, destination);

  const [sourceStat, destinationStat] = await Promise.all([
    fs.stat(sourcePath),
    fs.stat(destination),
  ]);

  if (sourceStat.size !== destinationStat.size) {
    await fs.unlink(destination);

    throw new Error(
      `La copia no coincide en tamaño: ` +
        `${sourceStat.size} != ${destinationStat.size}`,
    );
  }

  await fs.unlink(sourcePath);

  return destination;
}

// ============================================================
// Import
// ============================================================

async function importNewTransactions(
  accountId,
  newResults,
  accountConfig,
  mappingRules,
  resolvedCategories,
) {
  if (newResults.length === 0) {
    return {
      errors: [],
      added: [],
      updated: [],
    };
  }

  let transferPayeeId = null;

  if (accountConfig.transfer) {
    const payees = await actual.getPayees();

    const transferPayee = payees.find(
      (payee) => payee.transfer_acct === accountConfig.transfer.targetAccountId,
    );

    if (!transferPayee) {
      throw new Error(
        `No se encontró el transfer payee ` +
          `para la cuenta destino ` +
          `${accountConfig.transfer.targetAccountId}`,
      );
    }

    transferPayeeId = transferPayee.id;

    console.log('');
    console.log(`Transfer payee encontrado: ` + `${transferPayee.name}`);
  }

  const transactions = newResults.map((item) => {
    const shouldTransfer = isTransferTransaction(item.source, accountConfig);
    const category = shouldTransfer
      ? null
      : getCategoryForTransaction(
          item.source,
          mappingRules,
          resolvedCategories,
        );

    return {
      transaction: toActualTransaction(
        item.source,
        shouldTransfer ? transferPayeeId : null,
        category,
      ),
      category,
    };
  });

  console.log('');
  console.log(
    `Preparadas ${transactions.length} ` + `transacciones para importar.`,
  );

  for (const item of transactions) {
    console.log(
      `  ${item.transaction.date} | ` +
        `${formatMoney(item.transaction.amount)} | ` +
        `${
          item.transaction.payee_name ||
          item.transaction.payee ||
          item.transaction.imported_payee
        }` +
        `${item.transaction.payee ? ' | TRANSFERENCIA' : ''}` +
        `${
          item.category
            ? ` | ${item.category.categoryGroup} / ${item.category.category}`
            : ''
        }`,
    );
  }

  console.log('');
  console.log(DRY_RUN ? '⚠ SIMULANDO IMPORTACIÓN EN ACTUAL...' : '⚠ IMPORTANDO EN ACTUAL...');

  const result = await actual.importTransactions(
    accountId,
    transactions.map((item) => item.transaction),
    {
      defaultCleared: false,
      dryRun: DRY_RUN,
      reimportDeleted: false,
    },
  );

  console.log('');
  console.log('Resultado de importación:');

  console.log(result);

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Actual devolvió ` + `${result.errors.length} error(es)`);
  }

  return result;
}

// ============================================================
// Report
// ============================================================

function printReport(filePath, account, source, results) {
  const exists = results.filter((x) => x.status === 'EXISTS');

  const newer = results.filter((x) => x.status === 'NEW');

  const ambiguous = results.filter((x) => x.status === 'AMBIGUOUS');

  const hasBalance = source.every((transaction) =>
    Number.isFinite(transaction.balanceCents),
  );

  let startingBalance = null;
  let finalBalance = null;

  if (hasBalance) {
    const oldest = source[source.length - 1];

    startingBalance = oldest.balanceCents - oldest.amountCents;

    finalBalance = source[0].balanceCents;
  }
  console.log('');
  console.log('============================================================');

  console.log(
    `${account.bank.toUpperCase()} / ` + `${account.account.toUpperCase()}`,
  );

  console.log('============================================================');

  console.log('');

  console.log(`Fichero: ${filePath}`);

  console.log(`Transacciones: ${source.length}`);

  console.log('');

  console.log(`EXISTENTES       ${exists.length}`);

  console.log(`NUEVAS            ${newer.length}`);

  console.log(`AMBIGUAS          ${ambiguous.length}`);

  console.log('');

  if (hasBalance) {
    console.log(`Saldo inicial:   ${formatMoney(startingBalance)}`);

    console.log(`Saldo final CSV: ${formatMoney(finalBalance)}`);
  }

  // ----------------------------------------------------------
  // Existing matches
  // ----------------------------------------------------------

  if (exists.length > 0) {
    console.log('');
    console.log('--- EXISTENTES ---');

    for (const item of exists) {
      console.log(
        `${item.source.operationDate} | ` +
          `${formatMoney(item.source.amountCents)} | ` +
          `${item.method} | ` +
          `Actual: ${item.actual.date}`,
      );
    }
  }

  // ----------------------------------------------------------
  // New
  // ----------------------------------------------------------

  if (newer.length > 0) {
    console.log('');
    console.log('--- NUEVAS ---');

    for (const item of newer) {
      console.log(
        `${item.source.operationDate} | ` +
          `${formatMoney(item.source.amountCents)} | ` +
          `${item.source.concept}`,
      );
    }
  }

  // ----------------------------------------------------------
  // Ambiguous
  // ----------------------------------------------------------

  if (ambiguous.length > 0) {
    console.log('');
    console.log('--- AMBIGUAS ---');

    for (const item of ambiguous) {
      console.log('');
      console.log(
        `${item.source.operationDate} | ` +
          `${formatMoney(item.source.amountCents)} | ` +
          `${item.source.concept}`,
      );

      for (const candidate of item.candidates) {
        console.log(
          `  ↳ Actual: ${candidate.date} | ` +
            `${formatMoney(Number(candidate.amount))} | ` +
            `score=${candidate.matchScore} | ` +
            `id=${candidate.id}`,
        );
      }
    }
  }

  console.log('');
}

// ============================================================
// Process one file
// ============================================================

async function processFile(filePath, config, mappingRules, resolvedCategories) {
  console.log('');
  console.log(`Procesando: ${filePath}`);

  let account = null;

  try {
    // --------------------------------------------------------
    // Account
    // --------------------------------------------------------

    account = getAccountConfig(filePath, config);

    // --------------------------------------------------------
    // Read
    // --------------------------------------------------------

    const content = await fs.readFile(filePath, 'utf8');

    // --------------------------------------------------------
    // Parse
    // --------------------------------------------------------

    const sourceTransactions = parseFile(
      account.parser,
      content,
      filePath,
      account,
    );

    // --------------------------------------------------------
    // Existing Actual transactions
    // --------------------------------------------------------

    const actualTransactions = await getExistingTransactions(
      account.actualAccountId,
    );

    // --------------------------------------------------------
    // Compare
    // --------------------------------------------------------

    const results = compareTransactions(
      sourceTransactions,
      actualTransactions,
      account.dateToleranceDays,
    );

    // --------------------------------------------------------
    // Report
    // --------------------------------------------------------

    printReport(filePath, account, sourceTransactions, results);

    if (CATEGORIZE_EXISTING) {
      await categorizeExistingTransactions(
        results,
        account,
        mappingRules,
        resolvedCategories,
      );
    }

    const ambiguous = results.filter((x) => x.status === 'AMBIGUOUS');

    const newer = results.filter((x) => x.status === 'NEW');

    // --------------------------------------------------------
    // AMBIGUOUS
    // --------------------------------------------------------

    if (ambiguous.length > 0) {
      console.log('⚠ Transacciones ambiguas detectadas.');

      console.log('⚠ NO se importará ninguna transacción de este fichero.');

      if (DRY_RUN) {
        console.log('✓ Simulación completada. El fichero permanece en /inbox.');
        return;
      }

      const destination = await moveUnique(
        filePath,
        path.join(FAILED, account.bank, account.account),
      );

      console.log(`→ Movido a: ${destination}`);

      return;
    }

    // --------------------------------------------------------
    // NOTHING NEW
    // --------------------------------------------------------

    if (newer.length === 0) {
      console.log('✓ Todas las transacciones ya existen en Actual.');

      if (DRY_RUN) {
        console.log('✓ Simulación completada. El fichero permanece en /inbox.');
        return;
      }

      const destination = await moveUnique(
        filePath,
        path.join(PROCESSED, account.bank, account.account),
      );

      console.log(`→ Movido a: ${destination}`);

      return;
    }

    // --------------------------------------------------------
    // IMPORT NEW
    // --------------------------------------------------------

    const result = await importNewTransactions(
      account.actualAccountId,
      newer,
      account,
      mappingRules,
      resolvedCategories,
    );

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Actual devolvió errores durante la importación`);
    }

    if (DRY_RUN) {
      console.log('✓ Simulación completada. El fichero permanece en /inbox.');

      return;
    }

    if (!result.added || result.added.length !== newer.length) {
      throw new Error(
        `Se esperaban ${newer.length} ` +
          `transacciones añadidas pero Actual añadió ` +
          `${result.added?.length ?? 0}`,
      );
    }

    console.log('');
    console.log(`✓ Importadas ${result.added.length} transacción(es)`);

    // --------------------------------------------------------
    // SUCCESS → PROCESSED
    // --------------------------------------------------------

    const destination = await moveUnique(
      filePath,
      path.join(PROCESSED, account.bank, account.account),
    );

    console.log(`→ Movido a: ${destination}`);
  } catch (error) {
    console.error('');
    console.error(`❌ Error procesando ${filePath}`);

    console.error(error.message);

    // --------------------------------------------------------
    // ERROR → FAILED
    // --------------------------------------------------------

    try {
      const destinationDir = account
        ? path.join(FAILED, account.bank, account.account)
        : FAILED;

      const destination = await moveUnique(filePath, destinationDir);

      console.error(`→ Movido a: ${destination}`);
    } catch (moveError) {
      console.error(
        `❌ No se pudo mover el fichero a failed: ` + `${moveError.message}`,
      );
    }
  }
}

// ============================================================
// Process inbox
// ============================================================

async function processInbox(config, mappingRules) {
  const files = await findTransactionFiles(INBOX);

  if (files.length === 0) {
    return;
  }

  console.log('');
  console.log(`Encontrados ${files.length} fichero(s)`);

  await loadActual();

  try {
    const resolvedCategories = await resolveMappingCategories(mappingRules);

    for (const filePath of files) {
      await processFile(filePath, config, mappingRules, resolvedCategories);
    }
  } finally {
    await actual.shutdown();
  }
}

// ============================================================
// Watcher
// ============================================================

async function main() {
  console.log('');
  console.log('==========================================');
  console.log(' Actual Budget Importer');
  console.log('==========================================');
  console.log('');
  console.log(DRY_RUN ? 'Modo: SIMULACIÓN (DRY_RUN)' : 'Modo: AUTOMÁTICO');
  console.log(
    CATEGORIZE_EXISTING
      ? 'Categorización de existentes: ACTIVADA'
      : 'Categorización de existentes: desactivada',
  );
  console.log('Intervalo: 30 segundos');
  console.log('');

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const mappingRules = await loadMapping();

  if (mappingRules.length > 0) {
    console.log(`Cargadas ${mappingRules.length} regla(s) de categorías.`);
  }

  while (true) {
    try {
      await processInbox(config, mappingRules);
    } catch (error) {
      console.error('');
      console.error('❌ Error general:', error.message);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('');
    console.error('❌ ERROR FATAL');
    console.error(error);
    process.exit(1);
  });
}

export { parseRevolutAccountStatement };
