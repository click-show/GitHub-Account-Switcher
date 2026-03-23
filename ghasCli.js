"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePreferredBins = resolvePreferredBins;
exports.buildLaunchCandidates = buildLaunchCandidates;
const fs = require("node:fs");
const path = require("node:path");
function isSimpleCommandName(value) {
    return !/[\\/]/.test(value);
}
function hasExecutableExtension(value) {
    return /\.[^./\\]+$/.test(value);
}
function stripWrappingQuotes(value) {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
    }
    return value;
}
function appendUnique(target, values) {
    for (const value of values) {
        if (!target.includes(value)) {
            target.push(value);
        }
    }
}
function resolvePreferredBins(configuredBin) {
    const normalized = (configuredBin ?? '').trim();
    if (!normalized) {
        return ['gh', 'ghas'];
    }
    const lowercase = normalized.toLowerCase();
    if (lowercase === 'gh') {
        return ['gh', 'ghas'];
    }
    if (lowercase === 'ghas') {
        return ['ghas', 'gh'];
    }
    return [normalized];
}
function collectUserProfileRoots(env) {
    const roots = [];
    const userProfile = env.USERPROFILE;
    const home = env.HOME;
    const homeDrive = env.HOMEDRIVE;
    const homePath = env.HOMEPATH;
    if (userProfile) {
        appendUnique(roots, [userProfile]);
    }
    if (home) {
        appendUnique(roots, [home]);
    }
    if (homeDrive && homePath) {
        appendUnique(roots, [path.win32.join(homeDrive, homePath)]);
    }
    return roots;
}
function collectLocalAppDataRoots(env) {
    const roots = [];
    if (env.LOCALAPPDATA) {
        appendUnique(roots, [env.LOCALAPPDATA]);
    }
    for (const profileRoot of collectUserProfileRoots(env)) {
        appendUnique(roots, [path.win32.join(profileRoot, 'AppData', 'Local')]);
    }
    return roots;
}
function getPathVariable(env) {
    return env.PATH ?? env.Path ?? env.path;
}
function parseWindowsPathExt(env) {
    const defaults = ['.exe', '.cmd', '.bat', '.com'];
    const allowed = new Set(defaults);
    const raw = env.PATHEXT;
    if (!raw) {
        return defaults;
    }
    const normalized = raw
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
        const withDot = part.startsWith('.') ? part : `.${part}`;
        return withDot.toLowerCase();
    })
        .filter(part => allowed.has(part));
    appendUnique(normalized, defaults);
    return normalized;
}
function splitPathEntries(rawPath) {
    if (!rawPath) {
        return [];
    }
    return rawPath
        .split(path.delimiter)
        .map(entry => stripWrappingQuotes(entry.trim()))
        .filter(Boolean);
}
function buildPathDerivedCandidates(bin, platform, env, pathExists) {
    if (!isSimpleCommandName(bin)) {
        return [];
    }
    const pathEntries = splitPathEntries(getPathVariable(env));
    if (!pathEntries.length) {
        return [];
    }
    const candidates = [];
    if (platform === 'win32') {
        if (hasExecutableExtension(bin)) {
            for (const dir of pathEntries) {
                const candidate = path.win32.join(dir, bin);
                if (pathExists(candidate)) {
                    candidates.push(candidate);
                }
            }
            return candidates;
        }
        const pathExts = parseWindowsPathExt(env);
        for (const dir of pathEntries) {
            for (const ext of pathExts) {
                const candidate = path.win32.join(dir, `${bin}${ext}`);
                if (pathExists(candidate)) {
                    candidates.push(candidate);
                }
            }
        }
        return candidates;
    }
    for (const dir of pathEntries) {
        const candidate = path.posix.join(dir, bin);
        if (pathExists(candidate)) {
            candidates.push(candidate);
        }
    }
    return candidates;
}
function buildWindowsGhFallbacks(bin, env) {
    const lower = bin.toLowerCase();
    if (lower !== 'gh' && lower !== 'gh.exe') {
        return [];
    }
    const fallbacks = [];
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env['ProgramFiles(x86)'];
    const programW6432 = env.ProgramW6432;
    if (programFiles) {
        fallbacks.push(path.win32.join(programFiles, 'GitHub CLI', 'gh.exe'));
        fallbacks.push(path.win32.join(programFiles, 'GitHub CLI', 'bin', 'gh.exe'));
    }
    if (programFilesX86) {
        fallbacks.push(path.win32.join(programFilesX86, 'GitHub CLI', 'gh.exe'));
        fallbacks.push(path.win32.join(programFilesX86, 'GitHub CLI', 'bin', 'gh.exe'));
    }
    if (programW6432) {
        fallbacks.push(path.win32.join(programW6432, 'GitHub CLI', 'gh.exe'));
        fallbacks.push(path.win32.join(programW6432, 'GitHub CLI', 'bin', 'gh.exe'));
    }
    for (const localAppData of collectLocalAppDataRoots(env)) {
        fallbacks.push(path.win32.join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe'));
        fallbacks.push(path.win32.join(localAppData, 'Programs', 'GitHub CLI', 'bin', 'gh.exe'));
        fallbacks.push(path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'gh.exe'));
        fallbacks.push(path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe'));
    }
    const chocolateyInstall = env.ChocolateyInstall
        ?? (env.ProgramData ? path.win32.join(env.ProgramData, 'chocolatey') : undefined);
    if (chocolateyInstall) {
        fallbacks.push(path.win32.join(chocolateyInstall, 'bin', 'gh.exe'));
    }
    for (const profileRoot of collectUserProfileRoots(env)) {
        fallbacks.push(path.win32.join(profileRoot, 'scoop', 'shims', 'gh.exe'));
        fallbacks.push(path.win32.join(profileRoot, 'scoop', 'apps', 'gh', 'current', 'bin', 'gh.exe'));
    }
    return fallbacks;
}
function buildPosixGhFallbacks(bin, platform) {
    const lower = bin.toLowerCase();
    if (lower !== 'gh' && lower !== 'ghas') {
        return [];
    }
    if (platform === 'darwin') {
        return [
            `/opt/homebrew/bin/${lower}`,
            `/usr/local/bin/${lower}`,
            `/usr/bin/${lower}`
        ];
    }
    if (platform === 'linux') {
        return [
            `/usr/local/bin/${lower}`,
            `/usr/bin/${lower}`,
            `/snap/bin/${lower}`
        ];
    }
    return [];
}
function buildLaunchCandidates(preferredBins, platform = process.platform, env = process.env, pathExists = fs.existsSync) {
    const candidates = [];
    for (const bin of preferredBins) {
        appendUnique(candidates, [bin]);
        if (platform === 'win32') {
            if (isSimpleCommandName(bin) && !hasExecutableExtension(bin)) {
                appendUnique(candidates, [`${bin}.exe`]);
            }
            appendUnique(candidates, buildWindowsGhFallbacks(bin, env));
            appendUnique(candidates, buildPathDerivedCandidates(bin, platform, env, pathExists));
            continue;
        }
        appendUnique(candidates, buildPosixGhFallbacks(bin, platform));
        appendUnique(candidates, buildPathDerivedCandidates(bin, platform, env, pathExists));
    }
    return candidates;
}
//# sourceMappingURL=ghasCli.js.map