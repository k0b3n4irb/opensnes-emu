# Audio Unit Test Makefile

OPENSNES ?= $(error Set OPENSNES env var)
TARGET   := test_audio.sfc
ROM_NAME := AUDIO TESTS

CSRC     := test_audio.c
USE_LIB  := 1
LIB_MODULES := console dma text sprite audio

include $(OPENSNES)/make/common.mk
