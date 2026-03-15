# Object Engine Unit Test Makefile

OPENSNES ?= $(error Set OPENSNES env var)
TARGET   := test_object.sfc
ROM_NAME := OBJECT TESTS

CSRC     := test_object.c
USE_LIB  := 1
LIB_MODULES := console object map sprite sprite_dynamic sprite_lut dma text background debug

include $(OPENSNES)/make/common.mk
