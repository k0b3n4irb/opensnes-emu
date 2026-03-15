# Text Unit Test Makefile

OPENSNES ?= $(error Set OPENSNES env var)
TARGET   := test_text.sfc
ROM_NAME := TEXT TESTS

CSRC     := test_text.c
USE_LIB  := 1
LIB_MODULES := console text dma sprite

include $(OPENSNES)/make/common.mk
