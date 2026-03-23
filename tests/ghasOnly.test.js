"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("node:assert/strict");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
(0, node_test_1.test)('extension source keeps GHAS-only identifiers (no GS legacy namespace)', () => {
    const sourcePath = (0, node_path_1.join)(process.cwd(), 'extension.ts');
    const source = (0, node_fs_1.readFileSync)(sourcePath, 'utf8');
    assert.equal(source.includes('ghaSwitcher.'), false, 'extension.ts should not include legacy "ghaSwitcher." identifiers');
});
//# sourceMappingURL=ghasOnly.test.js.map