import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLaunchCandidates,
  resolvePreferredBins
} from '../ghasCli';

test('resolvePreferredBins keeps gh unchanged', () => {
  assert.deepEqual(resolvePreferredBins('gh'), ['gh', 'ghas']);
});

test('resolvePreferredBins adds gh fallback for ghas command', () => {
  assert.deepEqual(resolvePreferredBins('ghas'), ['ghas', 'gh']);
});

test('resolvePreferredBins keeps explicit executable paths unchanged', () => {
  assert.deepEqual(resolvePreferredBins('C:\\Tools\\ghas.exe'), ['C:\\Tools\\ghas.exe']);
});

test('buildLaunchCandidates adds Windows executable extensions for simple command names', () => {
  const candidates = buildLaunchCandidates(['ghas'], 'win32', {} as NodeJS.ProcessEnv);
  assert.equal(candidates.includes('ghas'), true);
  assert.equal(candidates.includes('ghas.exe'), true);
});

test('buildLaunchCandidates does not modify explicit executable paths', () => {
  assert.deepEqual(
    buildLaunchCandidates(['C:\\Tools\\ghas.exe'], 'win32'),
    ['C:\\Tools\\ghas.exe']
  );
});

test('buildLaunchCandidates adds common Windows install-path fallbacks for gh', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'
  } as NodeJS.ProcessEnv;

  const candidates = buildLaunchCandidates(['gh'], 'win32', env);
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

test('buildLaunchCandidates includes USERPROFILE-derived local app data fallbacks', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\maintenance\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\saqib'
  } as NodeJS.ProcessEnv;

  const candidates = buildLaunchCandidates(['gh'], 'win32', env);
  assert.equal(
    candidates.includes('C:\\Users\\maintenance\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'),
    true
  );
  assert.equal(
    candidates.includes('C:\\Users\\saqib\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'),
    true
  );
});

test('buildLaunchCandidates falls back to HOME-derived local app data when LOCALAPPDATA is missing', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    HOME: 'C:\\Users\\builder'
  } as NodeJS.ProcessEnv;

  const candidates = buildLaunchCandidates(['gh'], 'win32', env);
  assert.equal(
    candidates.includes('C:\\Users\\builder\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'),
    true
  );
});

test('buildLaunchCandidates adds common macOS fallback paths for gh', () => {
  const candidates = buildLaunchCandidates(['gh'], 'darwin');
  assert.equal(candidates.includes('/opt/homebrew/bin/gh'), true);
  assert.equal(candidates.includes('/usr/local/bin/gh'), true);
  assert.equal(candidates.includes('/usr/bin/gh'), true);
});

test('buildLaunchCandidates adds common Linux fallback paths for gh', () => {
  const candidates = buildLaunchCandidates(['gh'], 'linux');
  assert.equal(candidates.includes('/usr/local/bin/gh'), true);
  assert.equal(candidates.includes('/usr/bin/gh'), true);
  assert.equal(candidates.includes('/snap/bin/gh'), true);
});

test('buildLaunchCandidates includes PATH-derived windows candidates', () => {
  const env = {
    PATH: 'C:\\Tools\\bin;\"C:\\Program Files\\Some CLI\"',
    PATHEXT: '.COM;.EXE;.BAT;.CMD'
  } as NodeJS.ProcessEnv;

  const candidates = buildLaunchCandidates(['gh'], 'win32', env, () => true);
  assert.equal(candidates.includes('C:\\Tools\\bin\\gh.exe'), true);
  assert.equal(candidates.includes('C:\\Program Files\\Some CLI\\gh.exe'), true);
});
