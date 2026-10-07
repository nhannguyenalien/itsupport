import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkQuota, formatSize, isPlan, planLimitBytes } from '../src/db-backup/plans.js';

const GB = 2 ** 30, MB = 2 ** 20;

test('Free may back up 1 GB in total and Pro 20 GB', () => {
  assert.equal(planLimitBytes('free', {}), GB);
  assert.equal(planLimitBytes('pro', {}), 20 * GB);
  assert.equal(planLimitBytes('free', { PLAN_FREE_DB_GB: '2' }), 2 * GB, 'overridable per deployment');
  assert.equal(planLimitBytes('pro', { PLAN_PRO_DB_GB: 'garbage' }), 20 * GB, 'a bad override falls back to the default');
  assert.equal(planLimitBytes('free', { PLAN_FREE_DB_GB: '-3' }), GB);
});

test('the cap counts every database of the workspace together', () => {
  assert.equal(checkQuota('free', 0, 900 * MB, {}).ok, true);
  assert.equal(checkQuota('free', 400 * MB, 500 * MB, {}).ok, true);
  assert.equal(checkQuota('free', 400 * MB, 624 * MB, {}).ok, true, 'exactly 1 GB is allowed');
  assert.equal(checkQuota('free', 400 * MB, 625 * MB, {}).ok, false);
  assert.equal(checkQuota('free', 0, 2 * GB, {}).ok, false);
  assert.equal(checkQuota('pro', 5 * GB, 15 * GB, {}).ok, true);
  assert.equal(checkQuota('pro', 5 * GB, 16 * GB, {}).ok, false);
});

test('the refusal says what is used and how to get more', () => {
  const free = checkQuota('free', 600 * MB, 700 * MB, {});
  assert.match(free.message!, /gói Free \(1\.0 GB\)/);
  assert.match(free.message!, /600 MB/); assert.match(free.message!, /700 MB/);
  assert.match(free.message!, /Nâng cấp lên Pro .*20 GB/);
  const pro = checkQuota('pro', 19 * GB, 2 * GB, {});
  assert.match(pro.message!, /gói Pro/); assert.ok(!/Nâng cấp/.test(pro.message!), 'no upsell on the top plan');
});

test('plan names are validated', () => {
  assert.equal(isPlan('free'), true); assert.equal(isPlan('pro'), true);
  for (const bad of ['enterprise', 'FREE', '', null, undefined, 1]) assert.equal(isPlan(bad), false);
  assert.equal(formatSize(512), '1 KB'); assert.equal(formatSize(5 * MB), '5.0 MB'); assert.equal(formatSize(3 * GB), '3.0 GB'); assert.equal(formatSize(20 * GB), '20 GB');
});
