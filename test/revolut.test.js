import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRevolutAccountStatement } from '../src/importer.js';

const header =
  'Tipo\tProducto\tFecha de inicio\tFecha de finalizaciÃ³n\tDescripciÃ³n\tImporte\tComisiÃ³n\tDivisa\tState\tSaldo';

test('parses completed Revolut TSV transactions and includes fees', () => {
  const content = [
    header,
    'Pago con tarjeta\tActual\t2026-03-28 19:18:52\t2026-03-29 16:00:37\tMoonpay\t-15.7\t0.16\tEUR\tCOMPLETADO\t27.57',
    'Recargas\tActual\t2026-03-30 09:05:18\t2026-03-30 09:05:18\tGoogle Pay\t100\t0\tEUR\tCOMPLETADO\t127.57',
  ].join('\n');

  const transactions = parseRevolutAccountStatement(content);

  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions[0], {
    operationDate: '2026-03-28',
    valueDate: '2026-03-29',
    amountCents: -1586,
    balanceCents: 2757,
    concept: 'Moonpay',
    nif: '',
    reference: 'Pago con tarjeta / Actual',
    importedId: transactions[0].importedId,
  });
  assert.match(transactions[0].importedId, /^revolut:[a-f0-9]{64}$/);
  assert.equal(transactions[1].amountCents, 10000);
});

test('skips reversed Revolut transactions', () => {
  const content = [
    header,
    'Pago con tarjeta\tActual\t2026-08-31 14:02:14\t\tCloudFlare\t-0.87\t0\tEUR\tDEVUELTO\t',
    'Transferir\tActual\t2026-08-31 14:02:15\t2026-08-31 14:02:15\tA ahorro\t-0.13\t0\tEUR\tCOMPLETADO\t547.17',
  ].join('\n');

  const transactions = parseRevolutAccountStatement(content);

  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].concept, 'A ahorro');
});

test('accepts a USD statement when the account is configured for USD', () => {
  const content = [
    header,
    'Pago con tarjeta\tActual\t2026-09-01 9:00:00\t2026-09-01 9:00:01\tCoffee\t-5.25\t0\tUSD\tCOMPLETADO\t100',
  ].join('\n');

  const transactions = parseRevolutAccountStatement(content, 'USD');

  assert.equal(transactions[0].amountCents, -525);
  assert.equal(transactions[0].balanceCents, 10000);
});
