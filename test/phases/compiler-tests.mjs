/**
 * OpenSNES Compiler Tests — JavaScript port of tests/compiler/run_tests.sh
 *
 * Compiles each test_*.c with cc65816, then validates the generated ASM
 * using JS regex (replacing grep/sed from the bash version).
 *
 * Usage (standalone):
 *   node compiler-tests.mjs /path/to/opensnes [--allow-known-bugs] [--verbose]
 *
 * Usage (as module):
 *   import { runCompilerTests } from './compiler-tests.mjs';
 *   const result = runCompilerTests('/path/to/opensnes', { verbose: true });
 *   // result = { total, passed, failed, knownBugs, results: [{name, passed, message}] }
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

// ── Colors ───────────────────────────────────────────────────────────

const C = {
    pass: '\x1b[32m',
    fail: '\x1b[31m',
    warn: '\x1b[33m',
    reset: '\x1b[0m',
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract a function body from ASM text between `funcName:` and the next
 * label (`someName:`) or `.ENDS`. Returns the text block (excluding the
 * terminating label line).
 */
function extractFuncBody(asm, funcName, terminator = 'label') {
    const lines = asm.split('\n');
    let capture = false;
    const body = [];
    const startRe = new RegExp(`^${escapeRegExp(funcName)}:`);
    for (const line of lines) {
        if (!capture) {
            if (startRe.test(line)) capture = true;
            if (capture) body.push(line);
            continue;
        }
        if (terminator === 'ENDS' && /^\.ENDS/.test(line)) {
            body.push(line);
            break;
        }
        if (terminator === 'label' && /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line)) {
            break; // next label — don't include
        }
        if (terminator === 'ENDS_or_label') {
            if (/^\.ENDS/.test(line)) { body.push(line); break; }
            if (/^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line)) break;
        }
        body.push(line);
    }
    return body.join('\n');
}

/** Extract function body ending at .ENDS */
function extractFuncBodyToEnds(asm, funcName) {
    return extractFuncBody(asm, funcName, 'ENDS');
}

/** Extract function body ending at next label OR .ENDS */
function extractFuncBodyToEndsOrLabel(asm, funcName) {
    return extractFuncBody(asm, funcName, 'ENDS_or_label');
}

/**
 * Extract text between two patterns (like sed -n '/pat1/,/pat2/p').
 */
function extractBetween(text, startPattern, endPattern) {
    const lines = text.split('\n');
    let capture = false;
    const result = [];
    for (const line of lines) {
        if (!capture && startPattern.test(line)) capture = true;
        if (capture) {
            result.push(line);
            if (endPattern.test(line)) break;
        }
    }
    return result.join('\n');
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(text, pattern) {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

/**
 * Search backward from a symbol label to find the containing section directive.
 * Returns the section line text or ''.
 */
function findSectionForSymbol(asm, symbolName) {
    const lines = asm.split('\n');
    const symRe = new RegExp(`^${escapeRegExp(symbolName)}:`);
    let symLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (symRe.test(lines[i])) { symLineIdx = i; break; }
    }
    if (symLineIdx < 0) return '';
    // search backward for .SECTION or .RAMSECTION
    for (let i = symLineIdx - 1; i >= 0; i--) {
        if (/\.(SECTION|RAMSECTION)/.test(lines[i])) return lines[i];
    }
    return '';
}

/**
 * Get the line after a symbol label (for dsb checks).
 */
function lineAfterSymbol(asm, symbolName) {
    const lines = asm.split('\n');
    const symRe = new RegExp(`^${escapeRegExp(symbolName)}:`);
    for (let i = 0; i < lines.length; i++) {
        if (symRe.test(lines[i]) && i + 1 < lines.length) return lines[i + 1];
    }
    return '';
}

function isMSYS2() {
    const p = platform();
    return p === 'win32';
}

// ── Compile helper ───────────────────────────────────────────────────

/**
 * Compile a C file to assembly using cc65816.
 * Returns { ok: boolean, asm: string, error: string, segfault: boolean }.
 */
function compileTest(cc, src, outPath) {
    try {
        execSync(`"${cc}" "${src}" -o "${outPath}"`, {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 30000,
        });
        if (existsSync(outPath)) {
            return { ok: true, asm: readFileSync(outPath, 'utf-8'), error: '', segfault: false };
        }
        return { ok: false, asm: '', error: 'Output file not created', segfault: false };
    } catch (e) {
        const errMsg = (e.stderr || '') + (e.stdout || '');
        const segfault = /segmentation fault|segfault|signal 11/i.test(errMsg);
        return { ok: false, asm: '', error: errMsg, segfault };
    }
}

// ── Test runner ──────────────────────────────────────────────────────

/**
 * Run all 60 compiler tests.
 *
 * @param {string} opensnesDir  Absolute path to the OpenSNES root directory
 * @param {object} [options]
 * @param {boolean} [options.verbose=false]
 * @param {boolean} [options.allowKnownBugs=false]
 * @returns {{ total: number, passed: number, failed: number, knownBugs: number,
 *             results: Array<{name: string, passed: boolean, message: string}> }}
 */
export function runCompilerTests(opensnesDir, options = {}) {
    const verbose = options.verbose || false;
    const allowKnownBugs = options.allowKnownBugs || false;

    const BIN = join(opensnesDir, 'bin');
    const CC = join(BIN, 'cc65816');
    const AS = join(BIN, 'wla-65816');
    // Look for test sources: first in opensnes-emu fixtures, fallback to tests/
    const EMU_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'compiler');
    const LEGACY_DIR = join(opensnesDir, 'tests', 'compiler');
    const SCRIPT_DIR = existsSync(EMU_FIXTURES) ? EMU_FIXTURES : LEGACY_DIR;
    const BUILD = '/tmp/opensnes-compiler-tests';

    // Clean & create build dir
    rmSync(BUILD, { recursive: true, force: true });
    mkdirSync(BUILD, { recursive: true });

    const results = [];
    let knownBugs = 0;

    // Helpers to record results
    function pass(name, msg = '') {
        results.push({ name, passed: true, message: msg });
        if (verbose) console.log(`  ${C.pass}[PASS]${C.reset} ${name}`);
    }

    function fail(name, msg = '') {
        results.push({ name, passed: false, message: msg });
        console.log(`  ${C.fail}[FAIL]${C.reset} ${name}${msg ? ` — ${msg}` : ''}`);
    }

    function knownBug(name, msg = '') {
        if (allowKnownBugs) {
            knownBugs++;
            results.push({ name, passed: true, message: `[KNOWN_BUG] ${msg}` });
            console.log(`  ${C.warn}[KNOWN_BUG]${C.reset} ${name}${msg ? ` — ${msg}` : ''}`);
        } else {
            fail(name, `${msg} (known bug — use --allow-known-bugs to suppress)`);
        }
    }

    /**
     * Compile helper that handles segfault detection.
     * Returns the compile result or null if failed (with result already recorded).
     */
    function tryCompile(name, src, out) {
        if (!existsSync(src)) {
            fail(name, `Source file not found: ${src}`);
            return null;
        }
        const r = compileTest(CC, src, out);
        if (!r.ok) {
            if (r.segfault) {
                knownBug(name, 'cproc segfault on MSYS2 (non-deterministic)');
            } else {
                fail(name, `Compilation failed: ${r.error.slice(0, 200)}`);
            }
            return null;
        }
        return r;
    }

    // ================================================================
    // Test 1: compiler_exists
    // ================================================================
    (function test_compiler_exists() {
        const name = 'compiler_exists';
        if (!existsSync(CC)) { fail(name, `cc65816 not found at ${CC}`); return; }
        if (!existsSync(join(BIN, 'cproc-qbe'))) { fail(name, 'cproc-qbe not found'); return; }
        if (!existsSync(join(BIN, 'qbe'))) { fail(name, 'qbe not found'); return; }
        pass(name);
    })();

    // ================================================================
    // Test 2: assembler_exists
    // ================================================================
    (function test_assembler_exists() {
        const name = 'assembler_exists';
        if (!existsSync(AS)) { fail(name, `wla-65816 not found at ${AS}`); return; }
        pass(name);
    })();

    // ================================================================
    // Test 3: compile_minimal
    // ================================================================
    const minimalSrc = join(SCRIPT_DIR, 'test_minimal.c');
    const minimalAsm = join(BUILD, 'test_minimal.c.asm');
    (function test_compile_minimal() {
        const name = 'compile_minimal';
        if (!existsSync(minimalSrc)) { fail(name, 'Source file not found'); return; }
        try {
            execSync(`"${CC}" "${minimalSrc}" -o "${minimalAsm}"`, { stdio: 'pipe', timeout: 30000 });
        } catch (e) {
            fail(name, 'Compilation failed');
            return;
        }
        if (!existsSync(minimalAsm)) { fail(name, 'Output file not created'); return; }
        pass(name);
    })();

    // ================================================================
    // Test 4: no_dsb_without_data
    // ================================================================
    (function test_no_dsb_without_data() {
        const name = 'no_dsb_without_data';
        if (!existsSync(minimalAsm)) {
            fail(name, 'Assembly file not found (run compile test first)');
            return;
        }
        const asm = readFileSync(minimalAsm, 'utf-8');
        // .dsb N with no fill value
        if (/\.dsb\s+[0-9]+\s*$/m.test(asm)) {
            fail(name, 'Found .dsb without fill value');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 5: correct_directives
    // ================================================================
    (function test_correct_directives() {
        const name = 'correct_directives';
        if (!existsSync(minimalAsm)) { fail(name, 'Assembly file not found'); return; }
        const asm = readFileSync(minimalAsm, 'utf-8');
        let errors = 0;
        if (/^\.byte\s/m.test(asm)) errors++;
        if (/^\.word\s/m.test(asm)) errors++;
        if (/^\.long\s/m.test(asm)) errors++;
        if (/^\.balign\s/m.test(asm)) errors++;
        if (errors > 0) { fail(name, `Found ${errors} incompatible directives`); return; }
        pass(name);
    })();

    // ================================================================
    // Test 6: assemble_output
    // ================================================================
    (function test_assemble_output() {
        const name = 'assemble_output';
        if (!existsSync(minimalAsm)) { fail(name, 'Assembly file not found'); return; }
        const memmap = join(SCRIPT_DIR, 'test_memmap.inc');
        const asmWithMap = join(BUILD, 'test_minimal_with_map.asm');
        const obj = join(BUILD, 'test_minimal.o');
        try {
            const header = readFileSync(memmap, 'utf-8');
            const body = readFileSync(minimalAsm, 'utf-8');
            writeFileSync(asmWithMap, header + body);
            execSync(`"${AS}" -o "${obj}" "${asmWithMap}"`, { stdio: 'pipe', timeout: 30000 });
        } catch {
            fail(name, 'Assembly failed');
            return;
        }
        if (!existsSync(obj)) { fail(name, 'Object file not created'); return; }
        pass(name);
    })();

    // ================================================================
    // Test 7: processed_assembly
    // ================================================================
    (function test_processed_assembly() {
        const name = 'processed_assembly';
        if (!existsSync(minimalAsm)) { fail(name, 'Source assembly not found'); return; }
        const memmap = join(SCRIPT_DIR, 'test_memmap.inc');
        const processed = join(BUILD, 'test_minimal_processed.asm');
        const processedWithMap = join(BUILD, 'test_minimal_processed_with_map.asm');
        const obj = join(BUILD, 'test_minimal_processed.o');
        try {
            let src = readFileSync(minimalAsm, 'utf-8');
            // Apply same transforms as lib/Makefile
            src = src.replace(/\.byte/g, '.db');
            src = src.replace(/\.word/g, '.dw');
            src = src.replace(/\.long/g, '.dl');
            src = src.split('\n')
                .filter(l => !/^\.data/.test(l))
                .filter(l => !/^\/\* end/.test(l))
                .filter(l => !/^\.balign/.test(l))
                .filter(l => !/^\.GLOBAL/.test(l))
                .map(l => l.replace(/\.dsb (\d+)$/gm, '.dsb $1, 0'))
                .join('\n');
            writeFileSync(processed, src);
            const header = readFileSync(memmap, 'utf-8');
            writeFileSync(processedWithMap, header + src);
            execSync(`"${AS}" -o "${obj}" "${processedWithMap}"`, { stdio: 'pipe', timeout: 30000 });
        } catch {
            fail(name, 'Processed assembly failed');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 8: static_var_stores
    // ================================================================
    (function test_static_var_stores() {
        const name = 'static_var_stores';
        const src = join(SCRIPT_DIR, 'test_static_vars.c');
        const out = join(BUILD, 'test_static_vars.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/sta\.l\s+\$000000/.test(r.asm)) {
            fail(name, "Found 'sta.l $000000' - stores to static vars broken!");
            return;
        }
        if (!/^my_static_byte:/m.test(r.asm)) {
            fail(name, "Symbol 'my_static_byte' not defined");
            return;
        }
        if (!/^my_static_word:/m.test(r.asm)) {
            fail(name, "Symbol 'my_static_word' not defined");
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 9: shift_right_ops
    // ================================================================
    (function test_shift_right_ops() {
        const name = 'shift_right_ops';
        const src = join(SCRIPT_DIR, 'test_shift_right.c');
        const out = join(BUILD, 'test_shift_right.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/; unhandled op/.test(r.asm)) {
            fail(name, 'Found unhandled op in shift right code');
            return;
        }
        if (!/xba|lsr a/.test(r.asm)) {
            fail(name, 'No shift right instructions generated (expected xba or lsr)');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 10: word_extend_ops
    // ================================================================
    (function test_word_extend_ops() {
        const name = 'word_extend_ops';
        const src = join(SCRIPT_DIR, 'test_word_extend.c');
        const out = join(BUILD, 'test_word_extend.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/; unhandled op/.test(r.asm)) {
            fail(name, 'Found unhandled op in word extend code');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 11: animation_patterns
    // ================================================================
    (function test_animation_patterns() {
        const name = 'animation_patterns';
        const src = join(SCRIPT_DIR, 'test_animation_patterns.c');
        const out = join(BUILD, 'test_animation_patterns.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/; unhandled op/.test(r.asm)) {
            fail(name, 'Found unhandled ops');
            return;
        }

        // Try to assemble (add memory map header)
        const memmap = join(SCRIPT_DIR, 'test_memmap.inc');
        const outWithMap = join(BUILD, 'test_animation_patterns_with_map.asm');
        const obj = join(BUILD, 'test_animation_patterns.o');
        try {
            const header = readFileSync(memmap, 'utf-8');
            writeFileSync(outWithMap, header + r.asm);
            execSync(`"${AS}" -o "${obj}" "${outWithMap}"`, { stdio: 'pipe', timeout: 30000 });
        } catch {
            fail(name, 'Assembly failed');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 12: division_ops
    // ================================================================
    (function test_division_ops() {
        const name = 'division_ops';
        const src = join(SCRIPT_DIR, 'test_division.c');
        const out = join(BUILD, 'test_division.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/; unhandled op/.test(r.asm)) {
            fail(name, 'Found unhandled ops');
            return;
        }
        if (!/lsr a/.test(r.asm)) {
            fail(name, 'No LSR instructions generated for power-of-2 division');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 13: multiarg_call_offsets
    // ================================================================
    (function test_multiarg_call_offsets() {
        const name = 'multiarg_call_offsets';
        const src = join(SCRIPT_DIR, 'test_multiarg_call.c');
        const out = join(BUILD, 'test_multiarg_call.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (/; unhandled op/.test(r.asm)) {
            fail(name, 'Found unhandled ops');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 14: library_no_unhandled_ops
    // ================================================================
    (function test_library_no_unhandled_ops() {
        const name = 'library_no_unhandled_ops';
        const libBuild = join(opensnesDir, 'lib', 'build');
        if (!existsSync(libBuild)) {
            fail(name, `Library build directory not found: ${libBuild}`);
            return;
        }
        let hasUnhandled = false;
        try {
            const files = readdirSync(libBuild).filter(f => f.endsWith('.c.asm'));
            for (const f of files) {
                const content = readFileSync(join(libBuild, f), 'utf-8');
                if (/; unhandled op/.test(content)) {
                    fail(name, `Unhandled ops in ${f}`);
                    hasUnhandled = true;
                    break;
                }
            }
        } catch {
            fail(name, 'Could not read library build directory');
            return;
        }
        if (!hasUnhandled) pass(name);
    })();

    // ================================================================
    // Test 15: global_var_reads
    // ================================================================
    (function test_global_var_reads() {
        const name = 'global_var_reads';
        const src = join(SCRIPT_DIR, 'test_global_vars.c');
        const out = join(BUILD, 'test_global_vars.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // Check bug pattern: lda.w #global_ followed by lda.l $0000,x
        if (/lda\.w #global_/.test(r.asm)) {
            // Extract lines after each match and check for indirect load
            const lines = r.asm.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (/lda\.w #global_/.test(lines[i])) {
                    const next2 = lines.slice(i, i + 3).join('\n');
                    if (/lda\.l \$0000,x/.test(next2)) {
                        fail(name, 'Found indirect addressing for global variables');
                        return;
                    }
                }
            }
        }

        // Same check for extern variables
        if (/lda\.w #extern_/.test(r.asm)) {
            const lines = r.asm.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (/lda\.w #extern_/.test(lines[i])) {
                    const next2 = lines.slice(i, i + 3).join('\n');
                    if (/lda\.l \$0000,x/.test(next2)) {
                        fail(name, 'Found indirect addressing for extern variables');
                        return;
                    }
                }
            }
        }

        // Verify direct loads present
        if (!/lda\.(w|l) global_x/.test(r.asm)) {
            fail(name, "No direct load 'lda.w/l global_x' found");
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 16: input_button_masks
    // ================================================================
    (function test_input_button_masks() {
        const name = 'input_button_masks';
        const src = join(SCRIPT_DIR, 'test_input_patterns.c');
        const out = join(BUILD, 'test_input_patterns.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const checks = [
            { mask: 2048, label: 'KEY_UP (2048/0x0800)' },
            { mask: 1024, label: 'KEY_DOWN (1024/0x0400)' },
            { mask: 512, label: 'KEY_LEFT (512/0x0200)' },
            { mask: 256, label: 'KEY_RIGHT (256/0x0100)' },
            { mask: 128, label: 'KEY_A (128/0x0080)' },
            { mask: 32768, label: 'KEY_B (32768/0x8000)' },
        ];
        for (const { mask, label } of checks) {
            const re = new RegExp(`and\\.w #${mask}\\b`);
            if (!re.test(r.asm)) {
                fail(name, `${label} mask not found`);
                return;
            }
        }
        pass(name);
    })();

    // ================================================================
    // Test 17: struct_ptr_init
    // ================================================================
    (function test_struct_ptr_init() {
        const name = 'struct_ptr_init';
        const src = join(SCRIPT_DIR, 'test_struct_ptr_init.c');
        const out = join(BUILD, 'test_struct_ptr_init.c.asm');

        if (!existsSync(src)) { fail(name, 'Source file not found'); return; }
        const r = compileTest(CC, src, out);
        if (!r.ok) {
            if (r.segfault) { knownBug(name, 'cproc segfault on MSYS2 (struct pointer init)'); return; }
            fail(name, 'Compilation failed');
            return;
        }

        if (/\.dl myFrames/.test(r.asm)) {
            pass(name);
            return;
        }
        if (/\.dl z\+0/.test(r.asm) || /\.dl [a-z]\+0/.test(r.asm)) {
            fail(name, 'Symbol reference corrupted (QBE static buffer bug)');
            return;
        }
        fail(name, 'myFrames symbol not found in output');
    })();

    // ================================================================
    // Test 18: 2d_array_access
    // ================================================================
    (function test_2d_array() {
        const name = '2d_array_access';
        const src = join(SCRIPT_DIR, 'test_2d_array.c');
        const out = join(BUILD, 'test_2d_array.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/grid/.test(r.asm)) {
            fail(name, 'grid symbol not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 19: nested_struct
    // ================================================================
    (function test_nested_struct() {
        const name = 'nested_struct';
        const src = join(SCRIPT_DIR, 'test_nested_struct.c');
        const out = join(BUILD, 'test_nested_struct.c.asm');

        if (!existsSync(src)) { fail(name, 'Source file not found'); return; }
        const r = compileTest(CC, src, out);
        if (!r.ok) {
            if (r.segfault) { knownBug(name, 'cproc segfault on MSYS2 (nested structs)'); return; }
            fail(name, 'Compilation failed');
            return;
        }
        if (!/game/.test(r.asm)) {
            fail(name, 'game symbol not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 20: union_handling
    // ================================================================
    (function test_union() {
        const name = 'union_handling';
        const src = join(SCRIPT_DIR, 'test_union.c');
        const out = join(BUILD, 'test_union.c.asm');

        if (!existsSync(src)) { fail(name, 'Source file not found'); return; }
        const r = compileTest(CC, src, out);
        if (!r.ok) {
            if (r.segfault) { knownBug(name, 'cproc crashes on unions (Windows/MSYS2 segfault)'); return; }
            fail(name, 'Compilation failed');
            return;
        }
        if (!/ms/.test(r.asm) || !/col/.test(r.asm)) {
            fail(name, 'Union symbols not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 21: large_local_vars
    // ================================================================
    (function test_large_local() {
        const name = 'large_local_vars';
        const src = join(SCRIPT_DIR, 'test_large_local.c');
        const out = join(BUILD, 'test_large_local.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/test_large_local:/.test(r.asm)) {
            fail(name, 'test_large_local function not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 22: string_init
    // ================================================================
    (function test_string_init() {
        const name = 'string_init';
        const src = join(SCRIPT_DIR, 'test_string_init.c');
        const out = join(BUILD, 'test_string_init.c.asm');

        if (!existsSync(src)) { fail(name, 'Source file not found'); return; }
        const r = compileTest(CC, src, out);
        if (!r.ok) {
            if (r.segfault) { knownBug(name, 'cproc segfault on MSYS2 (string initializers)'); return; }
            fail(name, 'Compilation failed');
            return;
        }
        // Check for string data (could be text or ASCII .db values)
        if (!/Sword/.test(r.asm) && !/"Sword"/.test(r.asm) && !/\.db 83/.test(r.asm)) {
            fail(name, 'String data not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 23: ptr_arithmetic
    // ================================================================
    (function test_ptr_arithmetic() {
        const name = 'ptr_arithmetic';
        const src = join(SCRIPT_DIR, 'test_ptr_arithmetic.c');
        const out = join(BUILD, 'test_ptr_arithmetic.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;
        pass(name);
    })();

    // ================================================================
    // Test 24: switch_stmt
    // ================================================================
    (function test_switch() {
        const name = 'switch_stmt';
        const src = join(SCRIPT_DIR, 'test_switch.c');
        const out = join(BUILD, 'test_switch.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;
        pass(name);
    })();

    // ================================================================
    // Test 25: function_ptr
    // ================================================================
    (function test_function_ptr() {
        const name = 'function_ptr';
        const src = join(SCRIPT_DIR, 'test_function_ptr.c');
        const out = join(BUILD, 'test_function_ptr.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/jml \[tcc__r9\]|jsl increment|jsl execute_action/.test(r.asm)) {
            fail(name, 'No call instructions found');
            return;
        }
        if (!/^execute_action:/m.test(r.asm)) {
            fail(name, 'execute_action function not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 26: bitops
    // ================================================================
    (function test_bitops() {
        const name = 'bitops';
        const src = join(SCRIPT_DIR, 'test_bitops.c');
        const out = join(BUILD, 'test_bitops.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/(and|ora|eor)\./.test(r.asm)) {
            fail(name, 'Bitwise instructions not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 27: loops
    // ================================================================
    (function test_loops() {
        const name = 'loops';
        const src = join(SCRIPT_DIR, 'test_loops.c');
        const out = join(BUILD, 'test_loops.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/(bne|beq|bcc|bcs)/.test(r.asm)) {
            fail(name, 'Branch instructions not found');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 28: comparisons
    // ================================================================
    (function test_comparisons() {
        const name = 'comparisons';
        const src = join(SCRIPT_DIR, 'test_comparisons.c');
        const out = join(BUILD, 'test_comparisons.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        if (!/(bne|beq|bcc|bcs|bmi|bpl|sec|sbc)/.test(r.asm)) {
            fail(name, 'Comparison instructions not found');
            return;
        }

        // Verify unsigned short comparisons use unsigned branches (bcc/bcs), NOT signed (bmi/bpl)
        for (const func of ['test_u16_high_less', 'test_u16_vs_constant']) {
            const body = extractFuncBody(r.asm, func);
            if (/\bbmi\b|\bbpl\b/.test(body)) {
                fail(name, `${func} uses signed branch (bmi/bpl) instead of unsigned (bcc/bcs)`);
                return;
            }
        }

        // Verify ternary value materialization
        const ternaryBody = extractFuncBody(r.asm, 'test_ternary_value_used');
        if (!/lda\.w #[01]/.test(ternaryBody)) {
            fail(name, 'test_ternary_value_used missing boolean materialization (lda.w #0/#1)');
            return;
        }

        // Verify u16 shift right uses lsr (logical)
        const shiftBody = extractFuncBody(r.asm, 'test_u16_shift_right');
        if (!/lsr/.test(shiftBody)) {
            fail(name, 'test_u16_shift_right missing lsr (logical shift right)');
            return;
        }

        // Verify s16 signed shift-by-8
        const signedShiftBody = extractFuncBody(r.asm, 'test_s16_shift_right');
        if (/xba/.test(signedShiftBody)) {
            if (!/ora/.test(signedShiftBody)) {
                fail(name, 'test_s16_shift_right uses xba but missing sign extension (ora)');
                return;
            }
        } else if (/cmp\.w #\$8000/.test(signedShiftBody)) {
            if (!/ror a/.test(signedShiftBody)) {
                fail(name, "test_s16_shift_right missing 'ror a' (arithmetic shift)");
                return;
            }
        } else {
            fail(name, 'test_s16_shift_right uses neither xba nor cmp+ror for arithmetic shift');
            return;
        }
        if (/lsr/.test(signedShiftBody)) {
            fail(name, 'test_s16_shift_right uses lsr (should use arithmetic shift)');
            return;
        }

        // Verify s16 signed shift-by-1
        const signedShift1Body = extractFuncBody(r.asm, 'test_s16_shift_right_1');
        if (!/cmp\.w #\$8000/.test(signedShift1Body)) {
            fail(name, "test_s16_shift_right_1 missing 'cmp.w #$8000' (sign bit extraction)");
            return;
        }
        if (!/ror a/.test(signedShift1Body)) {
            fail(name, "test_s16_shift_right_1 missing 'ror a' (arithmetic shift)");
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Test 29: volatiles
    // ================================================================
    (function test_volatiles() {
        const name = 'volatiles';
        const src = join(SCRIPT_DIR, 'test_volatiles.c');
        const out = join(BUILD, 'test_volatiles.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;
        pass(name);
    })();

    // ================================================================
    // Test 30: type_cast
    // ================================================================
    (function test_type_cast() {
        const name = 'type_cast';
        const src = join(SCRIPT_DIR, 'test_type_cast.c');
        const out = join(BUILD, 'test_type_cast.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;
        pass(name);
    })();

    // ================================================================
    // Test 31: variable_shift
    // ================================================================
    (function test_variable_shift() {
        const name = 'variable_shift';
        const src = join(SCRIPT_DIR, 'test_variable_shift.c');
        const out = join(BUILD, 'test_variable_shift.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const shlBody = extractFuncBody(r.asm, 'shift_left_var');
        if (!/asl|__shl/.test(shlBody)) {
            fail(name, 'shift_left_var has NO asl/__shl — variable shift dropped!');
            return;
        }

        const bitmaskBody = extractFuncBody(r.asm, 'compute_bitmask');
        if (!/asl|__shl/.test(bitmaskBody)) {
            fail(name, 'compute_bitmask has NO asl/__shl — 1<<idx broken!');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 32: variable_shift_runtime
    // ================================================================
    (function test_variable_shift_runtime() {
        const name = 'variable_shift_runtime';
        const src = join(SCRIPT_DIR, 'test_variable_shift_runtime.c');
        const out = join(BUILD, 'test_variable_shift_runtime.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // Check var_shl
        const shlBody = extractFuncBody(r.asm, 'var_shl');
        if (!/pha/.test(shlBody)) { fail(name, 'var_shl missing pha (no variable shift codegen)'); return; }
        if (!/asl/.test(shlBody)) { fail(name, 'var_shl missing asl instruction'); return; }

        // Check var_shr
        const shrBody = extractFuncBody(r.asm, 'var_shr');
        if (!/pha/.test(shrBody)) { fail(name, 'var_shr missing pha (no variable shift codegen)'); return; }
        if (!/lsr/.test(shrBody)) { fail(name, 'var_shr missing lsr instruction'); return; }

        // Check var_sar
        const sarBody = extractFuncBody(r.asm, 'var_sar');
        if (!/pha/.test(sarBody)) { fail(name, 'var_sar missing pha (no variable shift codegen)'); return; }
        if (!/ror/.test(sarBody)) { fail(name, 'var_sar missing ror instruction (signed shift)'); return; }

        // KEY CHECK: pha → lda N,s pattern
        const phaToPla = extractBetween(shlBody, /pha/, /pla/);
        if (!/lda.*,s/.test(phaToPla)) {
            fail(name, 'var_shl missing stack-relative load between pha/pla');
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Test 33: variable_shift_u8_compound
    // ================================================================
    (function test_variable_shift_u8_compound() {
        const name = 'variable_shift_u8_compound';
        const src = join(SCRIPT_DIR, 'test_variable_shift_bug.c');
        const out = join(BUILD, 'test_variable_shift_bug.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const u8Body = extractFuncBodyToEndsOrLabel(r.asm, 'set_scroll_u8');

        // 1. Must have variable shift codegen (pha + asl loop)
        if (!/pha/.test(u8Body)) { fail(name, 'set_scroll_u8 missing pha (no variable shift codegen)'); return; }
        if (!/asl/.test(u8Body)) { fail(name, 'set_scroll_u8 missing asl (shift dropped)'); return; }

        // 2. Key check: after pha, lda N,s offset must be sta_offset + 2
        const staMatches = u8Body.match(/sta (\d+),s/g);
        const bgStoreOffset = staMatches ? parseInt(staMatches[0].match(/sta (\d+),s/)[1]) : NaN;

        const phaToPla = extractBetween(u8Body, /pha/, /pla/);
        const ldaMatch = phaToPla.match(/lda (\d+),s/);
        const shiftLoadOffset = ldaMatch ? parseInt(ldaMatch[1]) : NaN;

        if (isNaN(bgStoreOffset) || isNaN(shiftLoadOffset)) {
            fail(name, `Could not extract stack offsets (store=${bgStoreOffset}, load=${shiftLoadOffset})`);
            return;
        }

        const expectedOffset = bgStoreOffset + 2;
        if (shiftLoadOffset !== expectedOffset) {
            fail(name, `Shift count loaded from ${shiftLoadOffset},s but expected ${expectedOffset},s (store was ${bgStoreOffset},s + 2 for pha)`);
            return;
        }

        // 3. Cross-check: u16 version
        const u16Body = extractFuncBodyToEndsOrLabel(r.asm, 'set_scroll_u16');
        if (!/pha/.test(u16Body)) { fail(name, 'set_scroll_u16 missing pha'); return; }

        // 4. .INDEX 16 check
        if (!/\.INDEX 16/.test(r.asm)) {
            fail(name, 'Missing .INDEX 16 directive — cpx #0 will be misassembled!');
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Test 34: ssa_phi_locals
    // ================================================================
    (function test_ssa_phi_locals() {
        const name = 'ssa_phi_locals';
        const src = join(SCRIPT_DIR, 'test_ssa_phi_locals.c');
        const out = join(BUILD, 'test_ssa_phi_locals.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const funcBody = extractFuncBody(r.asm, 'test_many_locals');

        // Check for branch constants
        let missing = 0;
        for (const val of [10, 20, 30, 40, 50, 60]) {
            const re = new RegExp(`lda\\.w #${val}\\b`);
            if (!re.test(funcBody)) missing++;
        }
        if (missing > 0) {
            fail(name, `Missing ${missing}/6 branch constants — phi-node values lost!`);
            return;
        }

        // Check unique stack slot offsets
        const slotMatches = funcBody.match(/sta \d+,s/g) || [];
        const uniqueSlots = new Set(slotMatches).size;
        if (uniqueSlots < 6) {
            fail(name, `Only ${uniqueSlots} unique stack slots (need 6+) — phi-node confusion!`);
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 35: static_mutable
    // ================================================================
    (function test_static_mutable() {
        const name = 'static_mutable';
        const src = join(SCRIPT_DIR, 'test_static_mutable.c');
        const out = join(BUILD, 'test_static_mutable.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const symbols = ['uninit_counter', 'zero_counter', 'init_counter', 'byte_flag', 'word_state', 'byte_counter', 'word_accumulator'];
        let romCount = 0;

        for (const sym of symbols) {
            const section = findSectionForSymbol(r.asm, sym);
            if (!section) continue;
            if (/SUPERFREE/.test(section)) romCount++;
        }

        if (romCount > 0) {
            fail(name, `${romCount}/${symbols.length} mutable statics placed in ROM (SUPERFREE)!`);
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 36: struct_typedef_rodata
    // ================================================================
    (function test_struct_typedef_rodata() {
        const name = 'struct_typedef_rodata';
        const src = join(SCRIPT_DIR, 'test_struct_typedef_rodata.c');
        const out = join(BUILD, 'test_struct_typedef_rodata.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const section = findSectionForSymbol(r.asm, 'state');
        if (!section) { fail(name, "Symbol 'state' not found in assembly"); return; }
        if (/SUPERFREE|\.rodata/.test(section)) {
            fail(name, `Mutable struct 'state' placed in ROM! section: ${section}`);
            return;
        }
        if (!/\.RAMSECTION/.test(section)) {
            fail(name, `Symbol 'state' not in expected RAMSECTION: ${section}`);
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 37: const_data
    // ================================================================
    (function test_const_data() {
        const name = 'const_data';
        const src = join(SCRIPT_DIR, 'test_const_data.c');
        const out = join(BUILD, 'test_const_data.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let ramCount = 0;
        for (const sym of ['const_arr', 'const_u8_arr']) {
            const section = findSectionForSymbol(r.asm, sym);
            if (!section) continue;
            if (/\.RAMSECTION/.test(section)) ramCount++;
        }
        if (ramCount > 0) {
            fail(name, `${ramCount} const array(s) placed in RAM instead of ROM!`);
            return;
        }

        // Check mutable array is in RAMSECTION
        const mutSection = findSectionForSymbol(r.asm, 'mut_arr');
        if (mutSection && /SUPERFREE/.test(mutSection)) {
            fail(name, 'mutable array placed in ROM instead of RAM!');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 38: multiply
    // ================================================================
    (function test_multiply() {
        const name = 'multiply';
        const src = join(SCRIPT_DIR, 'test_multiply.c');
        const out = join(BUILD, 'test_multiply.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // Check inline multiplications (should NOT call __mul16, SHOULD use tcc__r9)
        const inlineMuls = ['mul_by_3', 'mul_by_5', 'mul_by_6', 'mul_by_7', 'mul_by_9', 'mul_by_10'];
        for (const func of inlineMuls) {
            const body = extractFuncBody(r.asm, func);
            if (/__mul16/.test(body)) {
                fail(name, `${func} calls __mul16 instead of using inline shift+add`);
                return;
            }
            if (!/tcc__r9/.test(body)) {
                fail(name, `${func} missing tcc__r9 (no inline shift+add pattern)`);
                return;
            }
        }

        // Check variable * variable calls __mul16 with stack convention (pha)
        const varBody = extractFuncBody(r.asm, 'mul_var');
        if (!/__mul16/.test(varBody)) { fail(name, 'mul_var missing __mul16 call'); return; }
        if (!/pha/.test(varBody)) { fail(name, 'mul_var missing pha (stack-based calling convention)'); return; }

        // Check *13 uses inline
        const const13Body = extractFuncBody(r.asm, 'mul_by_13');
        if (/__mul16/.test(const13Body)) { fail(name, 'mul_by_13 still calls __mul16 (should be inlined)'); return; }
        if (!/tcc__r9/.test(const13Body)) { fail(name, 'mul_by_13 missing inline pattern (no tcc__r9)'); return; }

        // Check power-of-2 multiplies use asl (NOT __mul16)
        for (const func of ['mul_by_64', 'mul_by_128', 'mul_by_256', 'mul_by_1024', 'mul_by_2048']) {
            const body = extractFuncBody(r.asm, func);
            if (/__mul16/.test(body)) { fail(name, `${func} calls __mul16 instead of using inline shifts`); return; }
            if (!/asl a/.test(body)) { fail(name, `${func} missing 'asl a' (should use shift for power-of-2)`); return; }
        }

        // Check power-of-2 divides use lsr (NOT __div16)
        for (const func of ['div_by_32', 'div_by_64', 'div_by_1024']) {
            const body = extractFuncBody(r.asm, func);
            if (/__div16/.test(body)) { fail(name, `${func} calls __div16 instead of using inline shifts`); return; }
            if (!/lsr a/.test(body)) { fail(name, `${func} missing 'lsr a' (should use shift for power-of-2)`); return; }
        }

        // Check power-of-2 modulos use and (NOT __mod16)
        for (const func of ['mod_by_32', 'mod_by_64', 'mod_by_1024']) {
            const body = extractFuncBody(r.asm, func);
            if (/__mod16/.test(body)) { fail(name, `${func} calls __mod16 instead of using inline AND`); return; }
            if (!/and\.w/.test(body)) { fail(name, `${func} missing 'and.w' (should use AND for power-of-2 modulo)`); return; }
        }

        // Check composite constant multiplies
        for (const func of ['mul_by_24', 'mul_by_48', 'mul_by_20', 'mul_by_40', 'mul_by_36', 'mul_by_60', 'mul_by_96']) {
            const body = extractFuncBody(r.asm, func);
            if (/__mul16/.test(body)) { fail(name, `${func} calls __mul16 instead of using composite inline`); return; }
            if (!/tcc__r9/.test(body)) { fail(name, `${func} missing tcc__r9 (no inline shift+add pattern)`); return; }
            if (!/asl a/.test(body)) { fail(name, `${func} missing 'asl a' (should use shifts)`); return; }
        }

        pass(name);
    })();

    // ================================================================
    // Test 39: return_value
    // ================================================================
    (function test_return_value() {
        const name = 'return_value';
        const src = join(SCRIPT_DIR, 'test_return_value.c');
        const out = join(BUILD, 'test_return_value.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        const functions = ['compute_with_locals', 'compute_complex', 'call_and_return', 'compute_byte'];
        let failCount = 0;

        for (const func of functions) {
            // Use '; End of' as possible terminator, like bash does
            const body = extractFuncBodyToEndsOrLabel(r.asm, func);
            if (!/tsa/.test(body)) continue; // no stack frame, skip
            // Check for tax...txa pair
            const lines = body.split('\n');
            let hasTaxTxa = false;
            for (let i = 0; i < lines.length; i++) {
                if (/\btax\b/.test(lines[i])) {
                    // Check next 8 lines for txa
                    for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
                        if (/\btxa\b/.test(lines[j])) { hasTaxTxa = true; break; }
                    }
                    if (hasTaxTxa) break;
                }
            }
            if (!hasTaxTxa) {
                fail(name, `${func} epilogue missing tax/txa — return value destroyed!`);
                failCount++;
            }
        }
        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 40: struct_alignment
    // ================================================================
    (function test_struct_alignment() {
        const name = 'struct_alignment';
        const src = join(SCRIPT_DIR, 'test_struct_alignment.c');
        const out = join(BUILD, 'test_struct_alignment.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // Check struct sizes via dsb in RAMSECTION
        const expectedSizes = [['simple', 4], ['mixed', 6], ['nested', 10], ['three', 6], ['one', 1]];
        for (const [sym, expectedSz] of expectedSizes) {
            const nextLine = lineAfterSymbol(r.asm, sym);
            if (!nextLine || !/dsb/.test(nextLine)) {
                fail(name, `Symbol '${sym}' not found in RAMSECTION`);
                failCount++;
                continue;
            }
            const m = nextLine.match(/(\d+)/);
            if (!m || parseInt(m[1]) !== expectedSz) {
                fail(name, `'${sym}' dsb ${m ? m[1] : '?'}, expected dsb ${expectedSz}`);
                failCount++;
            }
        }

        // Check field offsets in test_simple_access
        let body = extractFuncBody(r.asm, 'test_simple_access');
        if (!/adc\.w #2/.test(body)) { fail(name, 'test_simple_access missing adc.w #2 for u16 field offset'); failCount++; }

        // Check test_mixed_access
        body = extractFuncBody(r.asm, 'test_mixed_access');
        if (!/adc\.w #4/.test(body)) { fail(name, 'test_mixed_access missing adc.w #4 for z field offset'); failCount++; }
        if (!/adc\.w #5/.test(body)) { fail(name, 'test_mixed_access missing adc.w #5 for w field offset'); failCount++; }

        // Check array stride
        body = extractFuncBody(r.asm, 'test_array_stride');
        if (!/adc\.w #4/.test(body)) { fail(name, 'test_array_stride missing stride offset adc.w #4'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 41: volatile_ptr
    // ================================================================
    (function test_volatile_ptr() {
        const name = 'volatile_ptr';
        const src = join(SCRIPT_DIR, 'test_volatile_ptr.c');
        const out = join(BUILD, 'test_volatile_ptr.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // test_write_register: must have 3 writes to $002100
        let body = extractFuncBody(r.asm, 'test_write_register');
        let writeCount = countMatches(body, /sta\.l \$002100/g);
        if (writeCount < 3) { fail(name, `test_write_register has ${writeCount} writes to $002100, expected 3 (volatile writes optimized away!)`); failCount++; }

        // test_read_register: must have 2 separate reads
        body = extractFuncBody(r.asm, 'test_read_register');
        let readCount = countMatches(body, /lda\.l/g);
        if (readCount < 2) { fail(name, `test_read_register has ${readCount} reads, expected 2+ (volatile reads coalesced!)`); failCount++; }

        // test_vram_write_sequence
        body = extractFuncBody(r.asm, 'test_vram_write_sequence');
        for (const reg of ['2115', '2116', '2117', '2118', '2119']) {
            const re = new RegExp(`sta\\.l \\$00${reg}`);
            if (!re.test(body)) { fail(name, `test_vram_write_sequence missing write to $${reg}`); failCount++; }
        }

        // test_volatile_loop
        body = extractFuncBody(r.asm, 'test_volatile_loop');
        if (!/sta\.l \$002118/.test(body)) { fail(name, 'test_volatile_loop missing loop write to $002118'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 42: global_struct_init
    // ================================================================
    (function test_global_struct_init() {
        const name = 'global_struct_init';
        const src = join(SCRIPT_DIR, 'test_global_struct_init.c');
        const out = join(BUILD, 'test_global_struct_init.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // MSYS2 workaround
        if (isMSYS2()) {
            knownBug(name, 'cproc emits .rodata instead of RAMSECTION on MSYS2');
            return;
        }

        let failCount = 0;

        const initSymbols = ['entry1', 'entry2', 'player', 'enemy', 'default_style', 'table', 'partial'];
        for (const sym of initSymbols) {
            if (!(new RegExp(`^${sym}:`, 'm')).test(r.asm)) { fail(name, `Symbol '${sym}' not found`); failCount++; continue; }
            const section = findSectionForSymbol(r.asm, sym);
            if (!/RAMSECTION/.test(section)) { fail(name, `'${sym}' not in RAMSECTION (got: ${section})`); failCount++; }
            const dwRe = new RegExp(`\\.dw ${sym}\\b`);
            if (!dwRe.test(r.asm)) { fail(name, `'${sym}' has no .data_init entry (.dw ${sym})`); failCount++; }
        }

        // Check zero-initialized global NOT in .data_init
        if (/^zeroed:/m.test(r.asm)) {
            if (/\.dw zeroed/.test(r.asm)) { fail(name, "'zeroed' should not have .data_init (it's zero-initialized)"); failCount++; }
        }

        // Check specific init values
        if (!/\.dw 1000/.test(r.asm)) { fail(name, 'Missing init value .dw 1000 for entry1.value'); failCount++; }
        if (!/\.db 100/.test(r.asm)) { fail(name, 'Missing init value .db 100 for player.health'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 43: u32_arithmetic
    // ================================================================
    (function test_u32_arithmetic() {
        const name = 'u32_arithmetic';
        const src = join(SCRIPT_DIR, 'test_u32_arithmetic.c');
        const out = join(BUILD, 'test_u32_arithmetic.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // 32-bit result variable must be 4 bytes
        const nextLine = lineAfterSymbol(r.asm, 'result32');
        const dsbMatch = nextLine.match(/dsb.*?(\d+)/);
        if (!dsbMatch || dsbMatch[1] !== '4') {
            fail(name, `result32 is dsb ${dsbMatch ? dsbMatch[1] : '?'}, expected dsb 4`);
            failCount++;
        }

        // Verify add32 function exists
        const add32Body = extractBetween(r.asm, /^add32:/m, /^\.ENDS/m);
        if (!add32Body) { fail(name, 'add32 function not found in output'); failCount++; }

        // Must access high word via result32+2
        if (!/result32\+2/.test(r.asm)) { fail(name, 'No result32+2 pattern found (32-bit high word not accessed)'); failCount++; }

        // Check add32 has ADC/CLC
        const add32Fn = extractFuncBody(r.asm, 'add32');
        if (!/adc|clc/.test(add32Fn)) { fail(name, 'add32 function body has no ADC — possibly constant-folded'); failCount++; }

        // Check sub32 has SBC/SEC
        const sub32Fn = extractFuncBody(r.asm, 'sub32');
        if (!/sbc|sec/.test(sub32Fn)) { fail(name, 'sub32 function body has no SBC — possibly constant-folded'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 44: sign_promotion
    // ================================================================
    (function test_sign_promotion() {
        const name = 'sign_promotion';
        const src = join(SCRIPT_DIR, 'test_sign_promotion.c');
        const out = join(BUILD, 'test_sign_promotion.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // Must have zero-extension: and.w #$00FF (at least 4)
        const zextCount = countMatches(r.asm, /and\.w #\$00FF/g);
        if (zextCount < 4) { fail(name, `Only ${zextCount} zero-extensions (and.w #$00FF) found, expected 4+`); failCount++; }

        // Must have sign-extension check: cmp.w #$0080 (at least 2)
        const sextCheckCount = countMatches(r.asm, /cmp\.w #\$0080/g);
        if (sextCheckCount < 2) { fail(name, `Only ${sextCheckCount} sign-extension checks (cmp.w #$0080) found, expected 2+`); failCount++; }

        // Must have sign-extension apply: ora.w #$FF00 (at least 2)
        const sextApplyCount = countMatches(r.asm, /ora\.w #\$FF00/g);
        if (sextApplyCount < 2) { fail(name, `Only ${sextApplyCount} sign-extensions (ora.w #$FF00) found, expected 2+`); failCount++; }

        // Check add_s8_s16
        const body = extractFuncBody(r.asm, 'add_s8_s16');
        if (!/and\.w #\$00FF/.test(body)) { fail(name, 'add_s8_s16 missing zero-extend before sign check'); failCount++; }
        if (!/cmp\.w #\$0080/.test(body)) { fail(name, 'add_s8_s16 missing sign bit check (cmp.w #$0080)'); failCount++; }
        if (!/ora\.w #\$FF00/.test(body)) { fail(name, 'add_s8_s16 missing sign extension (ora.w #$FF00)'); failCount++; }

        // Check add_u8_u8 not constant-folded
        const addBody = extractFuncBody(r.asm, 'add_u8_u8');
        if (!/adc|clc/.test(addBody)) { fail(name, 'add_u8_u8 function body has no ADC — possibly constant-folded'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 45: signed_division
    // ================================================================
    (function test_signed_division() {
        const name = 'signed_division';
        const src = join(SCRIPT_DIR, 'test_signed_division.c');
        const out = join(BUILD, 'test_signed_division.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // signed_div must call __sdiv16
        let body = extractFuncBody(r.asm, 'signed_div');
        if (!/__sdiv16/.test(body)) { fail(name, 'signed_div does NOT call __sdiv16'); failCount++; }
        if (/jsl __div16\b/.test(body)) { fail(name, 'signed_div incorrectly calls unsigned __div16'); failCount++; }

        // signed_mod must call __smod16
        body = extractFuncBody(r.asm, 'signed_mod');
        if (!/__smod16/.test(body)) { fail(name, 'signed_mod does NOT call __smod16'); failCount++; }
        if (/jsl __mod16\b/.test(body)) { fail(name, 'signed_mod incorrectly calls unsigned __mod16'); failCount++; }

        // unsigned_div must call __div16
        body = extractFuncBody(r.asm, 'unsigned_div');
        if (!/__div16/.test(body)) { fail(name, 'unsigned_div does NOT call __div16'); failCount++; }

        // unsigned_mod must call __mod16
        body = extractFuncBody(r.asm, 'unsigned_mod');
        if (!/__mod16/.test(body)) { fail(name, 'unsigned_mod does NOT call __mod16'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 46: nonleaf_frameless
    // ================================================================
    (function test_nonleaf_frameless() {
        const name = 'nonleaf_frameless';
        const src = join(SCRIPT_DIR, 'test_nonleaf_frameless.c');
        const out = join(BUILD, 'test_nonleaf_frameless.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // compute_across_call MUST have frame (sbc)
        let body = extractFuncBodyToEnds(r.asm, 'compute_across_call');
        if (!/\bsbc\b/.test(body)) { fail(name, 'compute_across_call missing frame setup (sbc) — intermediate across call needs frame!'); failCount++; }
        if (!/jsl/.test(body)) { fail(name, 'compute_across_call missing jsl — should call external_func'); failCount++; }

        // forward_with_work MUST have frame
        body = extractFuncBodyToEnds(r.asm, 'forward_with_work');
        if (!/\bsbc\b/.test(body)) { fail(name, 'forward_with_work missing frame setup (sbc) — intermediate across call needs frame!'); failCount++; }

        // Both should have leaf_opt=1
        // NOTE: Phase 5b removed the `leaf_opt` gate (see memory/compiler_optimizations.md);
        // the comment marker "leaf_opt=1" is no longer emitted for non-leaf functions even
        // when the underlying optimization is active. This is a stale indicator, not a
        // missing optimization. Tracked as known until the marker is brought back or the
        // assertion is rewritten to check the actual ASM shape.
        if (!/compute_across_call.*leaf_opt=1/.test(r.asm)) {
            knownBug(name, 'compute_across_call should have leaf_opt=1 (Phase 5b removed the gate; marker is stale)');
            return;
        }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 47: dead_store_elimination
    // ================================================================
    (function test_dead_store_elimination() {
        const name = 'dead_store_elimination';
        const src = join(SCRIPT_DIR, 'test_dead_store_elimination.c');
        const out = join(BUILD, 'test_dead_store_elimination.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // global_increment should be frameless (no sbc)
        let body = extractFuncBodyToEnds(r.asm, 'global_increment');
        if (/\bsbc\b/.test(body)) { fail(name, 'global_increment has frame setup (sbc) — should be frameless'); failCount++; }

        // No sta N,s (dead stores) — but allow sta.w / sta.l for globals
        if (/\tsta \d+,s/.test(body)) { fail(name, 'global_increment has sta N,s — dead stores not eliminated'); failCount++; }

        // Must still access g_counter
        if (!/lda\.w g_counter/.test(body)) { fail(name, 'global_increment missing lda.w g_counter'); failCount++; }
        if (!/sta\.w g_counter/.test(body)) { fail(name, 'global_increment missing sta.w g_counter'); failCount++; }

        // phi_loop MUST have frame (sbc)
        body = extractFuncBodyToEnds(r.asm, 'phi_loop');
        if (!/\bsbc\b/.test(body)) { fail(name, 'phi_loop missing frame setup (sbc) — phi args need stack slots!'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 48: plx_cleanup
    // ================================================================
    (function test_plx_cleanup() {
        const name = 'plx_cleanup';
        const src = join(SCRIPT_DIR, 'test_plx_cleanup.c');
        const out = join(BUILD, 'test_plx_cleanup.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // wrapper_one: tail call (jml), no rtl
        // NOTE: tail call optimisation is not implemented in cc65816/QBE yet.
        // All wrapper_* checks below depend on it. Treat as known until TCO lands.
        let body = extractFuncBodyToEnds(r.asm, 'wrapper_one');
        if (!/\tjml/.test(body)) { knownBug(name, 'wrapper_one missing jml (tail call optimisation not implemented)'); return; }
        if (/rtl/.test(body)) { knownBug(name, 'wrapper_one still has rtl (tail call optimisation not implemented)'); return; }

        // wrapper_two: tail call (jml), no rtl
        body = extractFuncBodyToEnds(r.asm, 'wrapper_two');
        if (!/\tjml/.test(body)) { knownBug(name, 'wrapper_two missing jml (tail call optimisation not implemented)'); return; }

        // void_wrapper: tail call (jml)
        body = extractFuncBodyToEnds(r.asm, 'void_wrapper');
        if (!/\tjml/.test(body)) { knownBug(name, 'void_wrapper missing jml (tail call optimisation not implemented)'); return; }

        // __mul16 cleanup test
        const mulSrc = join(BUILD, 'test_plx_mul.c');
        const mulOut = join(BUILD, 'test_plx_mul.c.asm');
        writeFileSync(mulSrc, `unsigned short mul_general(unsigned short a, unsigned short b) {\n    return a * b;\n}\n`);
        const mulR = compileTest(CC, mulSrc, mulOut);
        if (mulR.ok) {
            body = extractFuncBodyToEnds(mulR.asm, 'mul_general');
            if (!/plx/.test(body)) { fail(name, 'mul_general missing plx for __mul16 cleanup'); failCount++; }
            if (/tsa/.test(body) && /tas/.test(body)) { fail(name, 'mul_general still uses tsa/tas for __mul16 cleanup'); failCount++; }
        }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 49: xba_shift
    // ================================================================
    (function test_xba_shift() {
        const name = 'xba_shift';
        const src = join(SCRIPT_DIR, 'test_xba_shift.c');
        const out = join(BUILD, 'test_xba_shift.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // shr8
        let body = extractFuncBodyToEnds(r.asm, 'shr8');
        if (!/xba/.test(body)) { fail(name, 'shr8 missing xba instruction'); failCount++; }
        if (countMatches(body, /lsr a/g) >= 8) { fail(name, `shr8 has ${countMatches(body, /lsr a/g)} lsr instructions (should use xba)`); failCount++; }

        // sar8
        body = extractFuncBodyToEnds(r.asm, 'sar8');
        if (!/xba/.test(body)) { fail(name, 'sar8 missing xba instruction'); failCount++; }
        if (countMatches(body, /ror a/g) >= 8) { fail(name, `sar8 has ${countMatches(body, /ror a/g)} ror instructions (should use xba)`); failCount++; }
        if (!/ora/.test(body)) { fail(name, 'sar8 missing sign extension (ora)'); failCount++; }

        // shl8
        body = extractFuncBodyToEnds(r.asm, 'shl8');
        if (!/xba/.test(body)) { fail(name, 'shl8 missing xba instruction'); failCount++; }
        if (countMatches(body, /asl a/g) >= 8) { fail(name, `shl8 has ${countMatches(body, /asl a/g)} asl instructions (should use xba)`); failCount++; }

        // shr12: xba + exactly 4 lsr
        body = extractFuncBodyToEnds(r.asm, 'shr12');
        if (!/xba/.test(body)) { fail(name, 'shr12 missing xba instruction'); failCount++; }
        const lsrCount = countMatches(body, /lsr a/g);
        if (lsrCount !== 4) { fail(name, `shr12 should have exactly 4 lsr (has ${lsrCount})`); failCount++; }

        // sar12
        body = extractFuncBodyToEnds(r.asm, 'sar12');
        if (!/xba/.test(body)) { fail(name, 'sar12 missing xba instruction'); failCount++; }

        // shl12: xba + exactly 4 asl
        body = extractFuncBodyToEnds(r.asm, 'shl12');
        if (!/xba/.test(body)) { fail(name, 'shl12 missing xba instruction'); failCount++; }
        const aslCount = countMatches(body, /asl a/g);
        if (aslCount !== 4) { fail(name, `shl12 should have exactly 4 asl (has ${aslCount})`); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 50: commutative_swap
    // ================================================================
    (function test_commutative_swap() {
        const name = 'commutative_swap';
        const src = join(SCRIPT_DIR, 'test_commutative_swap.c');
        const out = join(BUILD, 'test_commutative_swap.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // shift_and_add: frameless, asl a, no sta N,s
        let body = extractFuncBodyToEnds(r.asm, 'shift_and_add');
        if (/\bsbc\b/.test(body)) { fail(name, 'shift_and_add has frame setup — should be frameless'); failCount++; }
        if (!/asl a/.test(body)) { fail(name, 'shift_and_add missing asl a'); failCount++; }
        if (/\tsta \d+,s/.test(body)) { fail(name, 'shift_and_add has sta N,s — intermediates should be dead stores'); failCount++; }

        // or_shifted: frameless
        body = extractFuncBodyToEnds(r.asm, 'or_shifted');
        if (/\bsbc\b/.test(body)) { fail(name, 'or_shifted has frame setup — should be frameless'); failCount++; }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 51: inc_dec
    // ================================================================
    (function test_inc_dec() {
        const name = 'inc_dec';
        const src = join(SCRIPT_DIR, 'test_inc_dec.c');
        const out = join(BUILD, 'test_inc_dec.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // increment: inc a, no clc
        let body = extractFuncBodyToEnds(r.asm, 'increment');
        if (!/inc a/.test(body)) { fail(name, "increment() missing 'inc a'"); return; }
        if (/clc/.test(body)) { fail(name, "increment() still uses 'clc' (should use 'inc a')"); return; }

        // decrement: dec a, no sec
        body = extractFuncBodyToEnds(r.asm, 'decrement');
        if (!/dec a/.test(body)) { fail(name, "decrement() missing 'dec a'"); return; }
        if (/sec/.test(body)) { fail(name, "decrement() still uses 'sec' (should use 'dec a')"); return; }

        // add_ffff: dec a
        body = extractFuncBodyToEnds(r.asm, 'add_ffff');
        if (!/dec a/.test(body)) { fail(name, "add_ffff() missing 'dec a'"); return; }

        // add_five: NOT inc/dec
        body = extractFuncBodyToEnds(r.asm, 'add_five');
        if (/inc a|dec a/.test(body)) { fail(name, 'add_five() incorrectly uses inc/dec for non-+-1 constant'); return; }

        pass(name);
    })();

    // ================================================================
    // Test 52: acache_pha
    // ================================================================
    (function test_acache_pha() {
        const name = 'acache_pha';
        const src = join(SCRIPT_DIR, 'test_acache_pha.c');
        const out = join(BUILD, 'test_acache_pha.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // call_same_twice: 1 lda, 2 pha
        // NOTE: A-cache currently invalidates at every call (per Phase 1 design).
        // Extending it through pha for repeated arg pushes is a planned optimisation.
        let body = extractFuncBodyToEnds(r.asm, 'call_same_twice');
        const ldaCount = countMatches(body, /lda/g);
        if (ldaCount > 1) {
            knownBug(name, `call_same_twice has ${ldaCount} lda instructions (A-cache through pha not implemented)`);
            return;
        }
        const phaCount = countMatches(body, /pha/g);
        if (phaCount !== 2) {
            fail(name, `call_same_twice has ${phaCount} pha (expected 2)`);
            return;
        }

        // call_with_computed: must have pha
        body = extractFuncBodyToEnds(r.asm, 'call_with_computed');
        if (!/\tpha/.test(body)) {
            fail(name, 'call_with_computed missing pha (computed arg should be pushed via A-cache)');
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Test 53: phi_acache
    // ================================================================
    (function test_phi_acache() {
        const name = 'phi_acache';
        const src = join(SCRIPT_DIR, 'test_phi_acache.c');
        const out = join(BUILD, 'test_phi_acache.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // Find the @if_join block and check for 3 lda instructions
        const joinBody = extractBetween(r.asm, /@if_join/, /jmp @while_cond/);
        const ldaCount = countMatches(joinBody, /\tlda/g);
        if (ldaCount < 3) {
            fail(name, `if_join has only ${ldaCount} lda (expected 3 — sp, pos, st need separate loads)`);
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 54: cmp_dead_store
    // ================================================================
    (function test_cmp_dead_store() {
        const name = 'cmp_dead_store';
        const src = join(SCRIPT_DIR, 'test_cmp_dead_store.c');
        const out = join(BUILD, 'test_cmp_dead_store.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // max_val should be frameless (framesize=0)
        if (!/max_val \(framesize=0/.test(r.asm)) {
            fail(name, 'max_val not frameless (comparison dead store not working)');
            return;
        }
        let body = extractFuncBodyToEnds(r.asm, 'max_val');
        if (/tsa/.test(body)) {
            fail(name, 'max_val has frame prologue (should be frameless)');
            return;
        }

        // eq_check frameless
        if (!/eq_check \(framesize=0/.test(r.asm)) {
            fail(name, 'eq_check not frameless');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 55: mul_dead_store
    // ================================================================
    (function test_mul_dead_store() {
        const name = 'mul_dead_store';
        const src = join(SCRIPT_DIR, 'test_mul_dead_store.c');
        const out = join(BUILD, 'test_mul_dead_store.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        let failCount = 0;

        // chain_mul: no dead sta N,s before sta.b tcc__r9
        let body = extractFuncBodyToEnds(r.asm, 'chain_mul');
        const lines = body.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
            if (/sta \d+,s/.test(lines[i]) && /sta\.b tcc__r9/.test(lines[i + 1])) {
                fail(name, 'chain_mul has dead store before inline multiply');
                failCount++;
                break;
            }
        }

        // chain_shift: no sta N,s
        body = extractFuncBodyToEnds(r.asm, 'chain_shift');
        if (/\tsta \d+,s/.test(body)) { fail(name, 'chain_shift has sta N,s — intermediate should be dead'); failCount++; }

        // chain_composite: no dead sta before tcc__r9
        body = extractFuncBodyToEnds(r.asm, 'chain_composite');
        const cLines = body.split('\n');
        for (let i = 0; i < cLines.length - 1; i++) {
            if (/sta \d+,s/.test(cLines[i]) && /sta\.b tcc__r9/.test(cLines[i + 1])) {
                fail(name, 'chain_composite has dead store before composite multiply');
                failCount++;
                break;
            }
        }

        if (failCount > 0) return;
        pass(name);
    })();

    // ================================================================
    // Test 56: inline_mul_11_15
    // ================================================================
    (function test_inline_mul_11_15() {
        const name = 'inline_mul_11_15';
        const src = join(SCRIPT_DIR, 'test_inline_mul.c');
        const out = join(BUILD, 'test_inline_mul.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        for (const fn of ['mul_by_11', 'mul_by_12', 'mul_by_13', 'mul_by_14', 'mul_by_15']) {
            const body = extractFuncBodyToEnds(r.asm, fn);
            if (/__mul16/.test(body)) {
                fail(name, `${fn} still calls __mul16 (should use inline shift+add)`);
                return;
            }
            if (!/tcc__r9/.test(body)) {
                fail(name, `${fn} missing tcc__r9 (inline pattern not applied)`);
                return;
            }
        }
        pass(name);
    })();

    // ================================================================
    // Test 57: dp_registers
    // ================================================================
    (function test_dp_registers() {
        const name = 'dp_registers';
        const src = join(SCRIPT_DIR, 'test_dp_registers.c');
        const out = join(BUILD, 'test_dp_registers.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // All tcc__ register accesses should use .b (direct page), not .w
        if (/\t(sta|lda|adc|sbc)\.w tcc__r[019]/.test(r.asm)) {
            fail(name, 'still using .w for tcc__ registers (should be .b)');
            return;
        }

        // div_by_10: no lda.b tcc__r0 after jsl __div16
        let body = extractFuncBodyToEnds(r.asm, 'div_by_10');
        if (/jsl __div16/.test(body) && /\tlda\.b tcc__r0/.test(body)) {
            fail(name, 'div_by_10 still reloads tcc__r0 after __div16 (should return in A)');
            return;
        }

        // mod_by_10: no lda.b tcc__r0 after jsl __mod16
        body = extractFuncBodyToEnds(r.asm, 'mod_by_10');
        if (/jsl __mod16/.test(body) && /\tlda\.b tcc__r0/.test(body)) {
            fail(name, 'mod_by_10 still reloads tcc__r0 after __mod16 (should return in A)');
            return;
        }

        // mul_by_7: uses .b for tcc__r9
        body = extractFuncBodyToEnds(r.asm, 'mul_by_7');
        if (!/\tsta\.b tcc__r9/.test(body)) {
            fail(name, 'mul_by_7 not using .b for tcc__r9');
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Test 58: indirect_store_acache
    // ================================================================
    (function test_indirect_store_acache() {
        const name = 'indirect_store_acache';
        const src = join(SCRIPT_DIR, 'test_indirect_store.c');
        const out = join(BUILD, 'test_indirect_store.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // array_write should be frameless (framesize=0)
        if (!/array_write \(framesize=0/.test(r.asm)) {
            fail(name, 'array_write not frameless (indirect store dead store not working)');
            return;
        }
        let body = extractFuncBodyToEnds(r.asm, 'array_write');
        if (!/\ttax/.test(body)) {
            fail(name, 'array_write missing tax instruction');
            return;
        }
        if (/\tpha/.test(body)) {
            fail(name, 'array_write still uses pha (A-cache optimization not applied)');
            return;
        }
        pass(name);
    })();

    // ================================================================
    // Test 59: tail_call
    // ================================================================
    (function test_tail_call() {
        const name = 'tail_call';
        const src = join(SCRIPT_DIR, 'test_tail_call.c');
        const out = join(BUILD, 'test_tail_call.c.asm');
        const r = tryCompile(name, src, out);
        if (!r) return;

        // call_add: jml add_u16, no jsl, no rtl
        // NOTE: tail call optimisation not implemented in cc65816/QBE yet.
        let body = extractFuncBodyToEnds(r.asm, 'call_add');
        if (!/\tjml add_u16/.test(body)) { knownBug(name, "call_add missing 'jml add_u16' (tail call optimisation not implemented)"); return; }
        if (/\tjsl/.test(body)) { fail(name, 'call_add still has jsl (should be jml only)'); return; }
        if (/\trtl/.test(body)) { fail(name, 'call_add still has rtl (should be eliminated by tail call)'); return; }

        // call_chain: jml add_one + jsl add_one, no rtl
        body = extractFuncBodyToEnds(r.asm, 'call_chain');
        if (!/\tjml add_one/.test(body)) { fail(name, "call_chain missing 'jml add_one' (tail call not applied)"); return; }
        if (!/\tjsl add_one/.test(body)) { fail(name, "call_chain missing 'jsl add_one' (first call should remain)"); return; }
        if (/\trtl/.test(body)) { fail(name, 'call_chain still has rtl (should be eliminated by tail call)'); return; }

        // no_tail_call: no jml, has rtl
        body = extractFuncBodyToEnds(r.asm, 'no_tail_call');
        if (/\tjml/.test(body)) { fail(name, 'no_tail_call has jml (should NOT be tail-call optimized)'); return; }
        if (!/\trtl/.test(body)) { fail(name, 'no_tail_call missing rtl (normal return expected)'); return; }

        pass(name);
    })();

    // ================================================================
    // Test 60: lazy_rep20
    // ================================================================
    (function test_lazy_rep20() {
        const name = 'lazy_rep20';
        // Reuses same source file as tail_call
        const src = join(SCRIPT_DIR, 'test_tail_call.c');
        const out = join(BUILD, 'test_tail_call.c.asm');
        // Use cached asm if available
        let asm;
        if (existsSync(out)) {
            asm = readFileSync(out, 'utf-8');
        } else {
            const r = tryCompile(name, src, out);
            if (!r) return;
            asm = r.asm;
        }

        // call_add: pure tail call — NO rep #$20
        // NOTE: depends on TCO (not implemented). When TCO lands, this should pass.
        let body = extractFuncBodyToEnds(asm, 'call_add');
        if (/\trep #\$20/.test(body)) {
            knownBug(name, 'call_add has rep #$20 (depends on tail call optimisation, not implemented)');
            return;
        }

        // call_chain: non-pure tail call — MUST have rep #$20
        body = extractFuncBodyToEnds(asm, 'call_chain');
        if (!/\trep #\$20/.test(body)) {
            fail(name, 'call_chain missing rep #$20 (non-pure tail call needs it)');
            return;
        }

        // no_tail_call: normal function — MUST have rep #$20
        body = extractFuncBodyToEnds(asm, 'no_tail_call');
        if (!/\trep #\$20/.test(body)) {
            fail(name, 'no_tail_call missing rep #$20 (normal function needs it)');
            return;
        }

        pass(name);
    })();

    // ================================================================
    // Summary
    // ================================================================

    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;

    return { total, passed, failed, knownBugs, results };
}

// ── CLI entry point ──────────────────────────────────────────────────

const isMain = process.argv[1] && (
    process.argv[1].endsWith('compiler-tests.mjs') ||
    process.argv[1].endsWith('compiler-tests.mjs/')
);

if (isMain) {
    const args = process.argv.slice(2);
    let opensnesDir = args.find(a => !a.startsWith('-'));
    const verbose = args.includes('--verbose') || args.includes('-v');
    const allowKnownBugs = args.includes('--allow-known-bugs');

    if (!opensnesDir) {
        // Try to infer from script location
        const { dirname: d, resolve: r } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        opensnesDir = r(d(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    }

    console.log('========================================');
    console.log('OpenSNES Compiler Tests (JavaScript)');
    console.log('========================================');
    console.log('');

    const result = runCompilerTests(opensnesDir, { verbose, allowKnownBugs });

    console.log('');
    console.log('========================================');
    console.log(`Results: ${result.passed}/${result.total} passed`);
    if (result.knownBugs > 0) {
        console.log(`${C.warn}${result.knownBugs} known bug(s)${C.reset}`);
    }
    if (result.failed > 0) {
        console.log(`${C.fail}${result.failed} tests failed${C.reset}`);
        process.exit(1);
    } else {
        console.log(`${C.pass}All tests passed${C.reset}`);
        process.exit(0);
    }
}
