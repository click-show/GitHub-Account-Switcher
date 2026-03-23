"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("node:assert/strict");
const node_test_1 = require("node:test");
const ghasCli_1 = require("../ghasCli");
(0, node_test_1.test)('resolvePreferredBins keeps gh unchanged', () => {
    assert.deepEqual((0, ghasCli_1.resolvePreferredBins)('gh'), ['gh', 'ghas']);
});
(0, node_test_1.test)('resolvePreferredBins adds gh fallback for ghas command', () => {
    assert.deepEqual((0, ghasCli_1.resolvePreferredBins)('ghas'), ['ghas', 'gh']);
});
(0, node_test_1.test)('resolvePreferredBins keeps explicit executable paths unchanged', () => {
    assert.deepEqual((0, ghasCli_1.resolvePreferredBins)('C:\\Tools\\ghas.exe'), ['C:\\Tools\\ghas.exe']);
});
(0, node_test_1.test)('buildLaunchCandidates adds Windows executable extensions for simple command names', () => {
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['ghas'], 'win32', {});
    assert.equal(candidates.includes('ghas'), true);
    assert.equal(candidates.includes('ghas.exe'), true);
});
(0, node_test_1.test)('buildLaunchCandidates does not modify explicit executable paths', () => {
    assert.deepEqual((0, ghasCli_1.buildLaunchCandidates)(['C:\\Tools\\ghas.exe'], 'win32'), ['C:\\Tools\\ghas.exe']);
});
(0, node_test_1.test)('buildLaunchCandidates adds common Windows install-path fallbacks for gh', () => {
    const env = {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'
    };
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'win32', env);
    assert.equal(candidates.includes('gh'), true);
    assert.equal(candidates.includes('gh.exe'), true);
    assert.equal(candidates.includes('C:\\Program Files\\GitHub CLI\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Program Files\\GitHub CLI\\bin\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Program Files (x86)\\GitHub CLI\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Program Files (x86)\\GitHub CLI\\bin\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Users\\alice\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Users\\alice\\AppData\\Local\\Programs\\GitHub CLI\\bin\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\gh.exe'), true);
});
(0, node_test_1.test)('buildLaunchCandidates includes USERPROFILE-derived local app data fallbacks', () => {
    const env = {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\maintenance\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\saqib'
    };
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'win32', env);
    assert.equal(candidates.includes('C:\\Users\\maintenance\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Users\\saqib\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'), true);
});
(0, node_test_1.test)('buildLaunchCandidates falls back to HOME-derived local app data when LOCALAPPDATA is missing', () => {
    const env = {
        ProgramFiles: 'C:\\Program Files',
        HOME: 'C:\\Users\\builder'
    };
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'win32', env);
    assert.equal(candidates.includes('C:\\Users\\builder\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'), true);
});
(0, node_test_1.test)('buildLaunchCandidates adds common macOS fallback paths for gh', () => {
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'darwin');
    assert.equal(candidates.includes('/opt/homebrew/bin/gh'), true);
    assert.equal(candidates.includes('/usr/local/bin/gh'), true);
    assert.equal(candidates.includes('/usr/bin/gh'), true);
});
(0, node_test_1.test)('buildLaunchCandidates adds common Linux fallback paths for gh', () => {
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'linux');
    assert.equal(candidates.includes('/usr/local/bin/gh'), true);
    assert.equal(candidates.includes('/usr/bin/gh'), true);
    assert.equal(candidates.includes('/snap/bin/gh'), true);
});
(0, node_test_1.test)('buildLaunchCandidates includes PATH-derived windows candidates', () => {
    const env = {
        PATH: 'C:\\Tools\\bin;\"C:\\Program Files\\Some CLI\"',
        PATHEXT: '.COM;.EXE;.BAT;.CMD'
    };
    const candidates = (0, ghasCli_1.buildLaunchCandidates)(['gh'], 'win32', env, () => true);
    assert.equal(candidates.includes('C:\\Tools\\bin\\gh.exe'), true);
    assert.equal(candidates.includes('C:\\Program Files\\Some CLI\\gh.exe'), true);
});
//# sourceMappingURL=ghasCli.test.js.map