import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('extension source keeps GHAS-only identifiers (no GS legacy namespace)', () => {
  const sourcePath = join(process.cwd(), 'extension.ts');
  const source = readFileSync(sourcePath, 'utf8');

  assert.equal(
    source.includes('ghaSwitcher.'),
    false,
    'extension.ts should not include legacy "ghaSwitcher." identifiers'
  );
});
