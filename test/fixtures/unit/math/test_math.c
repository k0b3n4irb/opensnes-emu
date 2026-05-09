/**
 * @file test_math.c
 * @brief Unit tests for math functions
 *
 * Tests fixed-point math, trigonometry, etc.
 */

#include <snes.h>
#include <snes/math.h>
#include <snes/console.h>
#include <snes/text.h>

static u8 tests_passed;
static u8 tests_failed;

#define TEST(name, condition) do { \
    if (condition) { \
        tests_passed++; \
        textPrintAt(0, tests_passed + tests_failed, "PASS: " name); \
    } else { \
        tests_failed++; \
        textPrintAt(0, tests_passed + tests_failed, "FAIL: " name); \
    } \
} while(0)

void test_fixed_point(void) {
    fixed a, b;
    s16 result;

    // Test FIX macro (8.8 fixed point)
    a = FIX(10);
    TEST("FIX_10", a == 2560);  // 10 * 256 = 2560

    // Test UNFIX macro
    result = UNFIX(FIX(25));
    TEST("UNFIX_25", result == 25);

    // Test fixed-point addition
    a = FIX(5);
    b = FIX(3);
    result = UNFIX(a + b);
    TEST("fix_add", result == 8);

    // Test fixed-point subtraction
    result = UNFIX(a - b);
    TEST("fix_sub", result == 2);

    // Test fractional values
    a = FIX(1) / 2;  // 0.5
    b = FIX(1) / 2;  // 0.5
    result = UNFIX(a + b);
    TEST("fix_half", result == 1);

    // Test negative values
    a = FIX(-5);
    result = UNFIX(a);
    TEST("fix_neg", result == -5);

    // Test FIX_FRAC
    a = FIX(3) + 128;  // 3.5
    TEST("fix_frac", FIX_FRAC(a) == 128);

    // Test FIX_MAKE
    a = FIX_MAKE(5, 128);  // 5.5
    result = UNFIX(a);
    TEST("fix_make_int", result == 5);
    TEST("fix_make_frac", FIX_FRAC(a) == 128);
}

void test_fix_mul(void) {
    fixed a, b, result;

    // 2.0 * 3.0 = 6.0
    a = FIX(2);
    b = FIX(3);
    result = fixMul(a, b);
    TEST("fixMul_int", UNFIX(result) == 6);

    // 0.5 * 4.0 = 2.0
    a = FIX(1) / 2;
    b = FIX(4);
    result = fixMul(a, b);
    TEST("fixMul_frac", UNFIX(result) == 2);

    // -2.0 * 3.0 = -6.0
    a = FIX(-2);
    b = FIX(3);
    result = fixMul(a, b);
    TEST("fixMul_neg", UNFIX(result) == -6);
}

void test_trig(void) {
    fixed result;

    // sin(0) = 0
    result = fixSin(0);
    TEST("sin_0", UNFIX(result) == 0);

    // sin(64) = sin(90deg) = 1.0 (256 in fixed)
    result = fixSin(64);
    TEST("sin_90", result == 256 || result == 255);  // Allow small error

    // sin(128) = sin(180deg) = 0
    result = fixSin(128);
    TEST("sin_180", UNFIX(result) == 0);

    // cos(0) = 1.0
    result = fixCos(0);
    TEST("cos_0", result == 256 || result == 255);

    // cos(64) = cos(90deg) = 0
    result = fixCos(64);
    TEST("cos_90", UNFIX(result) == 0);
}

void test_fixAbs(void) {
    fixed result;

    result = fixAbs(FIX(10));
    TEST("fixAbs_pos", UNFIX(result) == 10);

    result = fixAbs(FIX(-10));
    TEST("fixAbs_neg", UNFIX(result) == 10);

    result = fixAbs(0);
    TEST("fixAbs_zero", result == 0);
}

void test_sqrt(void) {
    /* Integer sqrt — exact answers for perfect squares. */
    TEST("sqrt16_0",     sqrt16(0) == 0);
    TEST("sqrt16_1",     sqrt16(1) == 1);
    TEST("sqrt16_4",     sqrt16(4) == 2);
    TEST("sqrt16_100",   sqrt16(100) == 10);
    TEST("sqrt16_65025", sqrt16(65025) == 255);

    /* Floor behaviour — sqrt16 is the floor of the real square root. */
    TEST("sqrt16_2",     sqrt16(2) == 1);    /* sqrt(2) ≈ 1.414 */
    TEST("sqrt16_99",    sqrt16(99) == 9);   /* sqrt(99) ≈ 9.95 */

    /* fixSqrt: 8.8 fixed-point. fixSqrt(FIX(64)) = FIX(8). */
    TEST("fixSqrt_64",   fixSqrt(FIX(64)) == FIX(8));
    /* fixSqrt(FIX(1)) — sqrt(1.0) = 1.0, but precision is 4 fractional
     * bits (sqrt16 returns 16 for raw=256, then <<4 = 256 = FIX(1)). */
    TEST("fixSqrt_1",    fixSqrt(FIX(1)) == FIX(1));
    /* Negative inputs return 0 (defined-but-zero). */
    TEST("fixSqrt_neg",  fixSqrt(-100) == 0);
}

void test_atan2(void) {
    /* Cardinal directions. The 8-bit angle convention used by the
     * sin/cos LUT: 0 = +X, 64 = +Y, 128 = -X, 192 = -Y. */
    TEST("atan2_origin", atan2_8(0, 0) == 0);   /* defined-but-zero */
    TEST("atan2_east",   atan2_8(0, 100) == 0);   /* +X axis */
    TEST("atan2_south",  atan2_8(100, 0) == 64);  /* +Y axis */
    TEST("atan2_west",   atan2_8(0, -100) == 128); /* -X axis */
    TEST("atan2_north",  atan2_8(-100, 0) == 192); /* -Y axis */

    /* Diagonals — within ±1 of the exact angle (LUT precision). */
    {
        u8 a;
        a = atan2_8(100, 100);   /* +X +Y → 45° = angle 32 */
        TEST("atan2_se", a >= 31 && a <= 33);
        a = atan2_8(-100, 100);  /* +X -Y → 315° = angle 224 */
        TEST("atan2_ne", a >= 223 && a <= 225);
    }

    /* Scale invariance — same angle for proportional inputs. */
    TEST("atan2_scale", atan2_8(50, 50) == atan2_8(5000, 5000));
}

void test_random(void) {
    u16 r1, r2, r3;

    // Seed random
    srand(12345);

    // Get random numbers
    r1 = rand();
    r2 = rand();
    r3 = rand();

    // Test: Numbers should be different
    TEST("rand_diff_1_2", r1 != r2);
    TEST("rand_diff_2_3", r2 != r3);

    // Test: Reproducible with same seed
    srand(12345);
    TEST("rand_repro", rand() == r1);
}

void main(void) {
    consoleInit();
    setMode(BG_MODE0, 0);
    textInit(TEXT_DEFAULT_TILEMAP_ADDR, TEXT_DEFAULT_FONT_TILE, TEXT_DEFAULT_PALETTE);
    setScreenOn();

    textPrintAt(0, 0, "=== Math Tests ===");

    tests_passed = 0;
    tests_failed = 0;

    test_fixed_point();
    test_fix_mul();
    test_trig();
    test_fixAbs();
    test_sqrt();
    test_atan2();
    test_random();

    textPrintAt(0, 26, "--------------------");
    if (tests_failed == 0) {
        textPrintAt(0, 27, "ALL TESTS PASSED!");
    } else {
        textPrintAt(0, 27, "SOME TESTS FAILED");
    }

    while (1) {
        WaitForVBlank();
    }
}
