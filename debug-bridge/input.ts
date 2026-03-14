/**
 * Joypad input controller.
 *
 * Maps named buttons to SNES joypad bitmask values
 * and provides convenience methods for input simulation.
 */

import { DebugEmulator } from './emulator.js';
import { BUTTON, type ButtonName } from './types.js';

export class InputController {
    constructor(private emulator: DebugEmulator) {}

    /**
     * Set the full button state for a pad (bitmask).
     */
    setButtons(pad: number, buttons: number): void {
        this.emulator.setInput(pad, buttons);
    }

    /**
     * Press a named button.
     */
    pressButton(pad: number, button: ButtonName): void {
        const mask = BUTTON[button];
        if (mask === undefined) {
            throw new Error(`Unknown button: ${button}`);
        }
        this.emulator.pressButton(pad, mask);
    }

    /**
     * Release a named button.
     */
    releaseButton(pad: number, button: ButtonName): void {
        const mask = BUTTON[button];
        if (mask === undefined) {
            throw new Error(`Unknown button: ${button}`);
        }
        this.emulator.releaseButton(pad, mask);
    }

    /**
     * Release all buttons on a pad.
     */
    releaseAll(pad: number): void {
        this.emulator.releaseAll(pad);
    }

    /**
     * Press a button, run N frames, then release it.
     * Simulates a quick button tap.
     */
    tap(pad: number, button: ButtonName, holdFrames: number = 2): void {
        this.pressButton(pad, button);
        this.emulator.runFrames(holdFrames);
        this.releaseButton(pad, button);
    }

    /**
     * Press multiple buttons simultaneously.
     */
    pressMultiple(pad: number, buttons: ButtonName[]): void {
        for (const button of buttons) {
            this.pressButton(pad, button);
        }
    }

    /**
     * Parse a button name string to its bitmask value.
     */
    static buttonNameToMask(name: string): number {
        const upper = name.toUpperCase() as ButtonName;
        const mask = BUTTON[upper];
        if (mask === undefined) {
            throw new Error(`Unknown button: ${name}. Valid: ${Object.keys(BUTTON).join(', ')}`);
        }
        return mask;
    }

    /**
     * Parse a comma-separated button string to a bitmask.
     * e.g., "A,RIGHT,START" → 0x0180 | 0x1000
     */
    static parseButtonString(str: string): number {
        let mask = 0;
        for (const name of str.split(',')) {
            mask |= InputController.buttonNameToMask(name.trim());
        }
        return mask;
    }
}
