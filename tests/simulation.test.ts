import test from 'node:test';
import assert from 'node:assert/strict';
import { simulation, simulationCoversSearchCategories } from '../fixtures/simulation.js';
import { validateSnapshot } from '../server/data.js';
import { DOCUMENT_CATEGORIES } from '../shared/types.js';

test('simulation data is fictional and covers every search document category', () => {
  const snapshot = simulation();
  validateSnapshot(snapshot);
  assert.equal(simulationCoversSearchCategories(), true);
  assert.equal(DOCUMENT_CATEGORIES.length, 9);
  assert.ok(snapshot.patients.every(row => row.name.endsWith('模拟') || row.name.endsWith('对照')));
  assert.ok(snapshot.planRequests.some(row => (row.prescribed_fractions ?? 0) > 2));
});
