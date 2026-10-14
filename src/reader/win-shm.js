'use strict';

// Minimal Win32 named-shared-memory reader.
// LMU inherits rFactor 2's plugin, which publishes six read-only mapped files.

const koffi = require('koffi');

const FILE_MAP_READ = 0x0004;
const ERROR_FILE_NOT_FOUND = 2;

let kernel32 = null;
let fns = null;

function load() {
    if (fns) return fns;

    if (process.platform !== 'win32') {
        throw new Error(
            `This probe reads Win32 named shared memory and only runs on Windows ` +
            `(current platform: ${process.platform}). Run it on the box with LMU installed.`
        );
    }

    kernel32 = koffi.load('kernel32.dll');

    fns = {
        OpenFileMappingW: kernel32.func(
            'void* __stdcall OpenFileMappingW(uint32_t dwDesiredAccess, int bInheritHandle, str16 lpName)'
        ),
        MapViewOfFile: kernel32.func(
            'void* __stdcall MapViewOfFile(void* hFileMappingObject, uint32_t dwDesiredAccess, ' +
            'uint32_t dwFileOffsetHigh, uint32_t dwFileOffsetLow, size_t dwNumberOfBytesToMap)'
        ),
        UnmapViewOfFile: kernel32.func('int __stdcall UnmapViewOfFile(const void* lpBaseAddress)'),
        CloseHandle: kernel32.func('int __stdcall CloseHandle(void* hObject)'),
        GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    };

    return fns;
}

/**
 * Open a named mapping read-only and return a Buffer that aliases the live
 * shared memory. Reads through it are NOT atomic -- callers must use the
 * version-counter protocol (see readFrame in probe.js).
 */
function openMapping(name, bytes) {
    const k = load();

    const handle = k.OpenFileMappingW(FILE_MAP_READ, 0, name);
    if (!handle) {
        const err = k.GetLastError();
        if (err === ERROR_FILE_NOT_FOUND) {
            throw new Error(
                `Mapping "${name}" not found (GetLastError=2).\n` +
                `  - Is Le Mans Ultimate running and in a session (not the main menu)?\n` +
                `  - Is rFactor2SharedMemoryMapPlugin64.dll in ...\\Le Mans Ultimate\\Plugins\\ ?\n` +
                `  - Is it enabled in UserData\\player\\CustomPluginVariables.JSON, with the\n` +
                `    leading space in " Enabled" preserved?`
            );
        }
        throw new Error(`OpenFileMappingW("${name}") failed, GetLastError=${err}`);
    }

    const view = k.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, bytes);
    if (!view) {
        const err = k.GetLastError();
        k.CloseHandle(handle);
        throw new Error(`MapViewOfFile failed for "${name}", GetLastError=${err}`);
    }

    // Zero-copy window onto the mapping (koffi >= 2.11).
    const live = Buffer.from(koffi.view(view, bytes));

    return {
        live,
        close() {
            k.UnmapViewOfFile(view);
            k.CloseHandle(handle);
        },
    };
}

module.exports = { openMapping };
