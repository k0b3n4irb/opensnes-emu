/**
 * CPU register access and state inspection.
 */

import type { Snes9xModule, CPUState } from './types.js';

export class CPUInspector {
    constructor(private core: Snes9xModule) {}

    /**
     * Get a full CPU state snapshot.
     */
    getState(): CPUState {
        const p = this.core._bridge_get_p();
        return {
            pc: this.core._bridge_get_pc(),
            a:  this.core._bridge_get_a(),
            x:  this.core._bridge_get_x(),
            y:  this.core._bridge_get_y(),
            sp: this.core._bridge_get_sp(),
            db: this.core._bridge_get_db(),
            pb: this.core._bridge_get_pb(),
            p,
            flags: {
                carry:      !!(p & 0x01),
                zero:       !!(p & 0x02),
                irqDisable: !!(p & 0x04),
                decimal:    !!(p & 0x08),
                indexSize:  !!(p & 0x10),  // 1 = 8-bit X/Y
                accumSize:  !!(p & 0x20),  // 1 = 8-bit A
                overflow:   !!(p & 0x40),
                negative:   !!(p & 0x80),
                emulation:  false, // Bridge doesn't expose emulation flag; 65816 always native on SNES
            },
        };
    }

    /**
     * Get the full 24-bit program counter (PB:PC).
     */
    getFullPC(): number {
        return (this.core._bridge_get_pb() << 16) | this.core._bridge_get_pc();
    }

    /**
     * Format the CPU state as a human-readable string.
     */
    formatState(): string {
        const s = this.getState();
        const flagStr = [
            s.flags.negative ? 'N' : 'n',
            s.flags.overflow ? 'V' : 'v',
            s.flags.accumSize ? 'M' : 'm',
            s.flags.indexSize ? 'X' : 'x',
            s.flags.decimal ? 'D' : 'd',
            s.flags.irqDisable ? 'I' : 'i',
            s.flags.zero ? 'Z' : 'z',
            s.flags.carry ? 'C' : 'c',
        ].join('');

        return `PC=${hex(s.pb, 2)}:${hex(s.pc, 4)} A=${hex(s.a, 4)} X=${hex(s.x, 4)} Y=${hex(s.y, 4)} SP=${hex(s.sp, 4)} DB=${hex(s.db, 2)} P=${flagStr}`;
    }
}

function hex(value: number, digits: number): string {
    return value.toString(16).toUpperCase().padStart(digits, '0');
}
