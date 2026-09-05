SHELL := /bin/bash
SDK_PATH := $(shell xcrun --show-sdk-path --sdk iphonesimulator)
DEVICE_ID := $(shell xcrun simctl list devices | grep -E "iPhone 17 .*\(Booted\)" | head -n1 | grep -oE "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")
ifeq ($(DEVICE_ID),)
  DEVICE_ID := booted
endif

BUNDLE_DIR := build/SwiftTodoApp.app
BUNDLE_ID := com.pyric.swifttodoapp

.PHONY: all build bundle install launch run logs screenshot stop uninstall clean

all: build bundle

build:
	@echo "==> Compiling SwiftTodoApp for iOS Simulator..."
	swift build --package-path . --triple arm64-apple-ios18.0-simulator --sdk "$(SDK_PATH)"

bundle: build
	@echo "==> Assembling SwiftTodoApp.app bundle..."
	mkdir -p $(BUNDLE_DIR)
	cp .build/arm64-apple-ios-simulator/debug/SwiftTodoApp $(BUNDLE_DIR)/SwiftTodoApp
	cp Info.plist $(BUNDLE_DIR)/Info.plist
	echo -n "APPL????" > $(BUNDLE_DIR)/PkgInfo

install: bundle
	@echo "==> Installing on simulator ($(DEVICE_ID))..."
	xcrun simctl install $(DEVICE_ID) $(BUNDLE_DIR)

launch:
	@echo "==> Launching $(BUNDLE_ID) on simulator..."
	xcrun simctl launch $(DEVICE_ID) $(BUNDLE_ID)

run: install launch

logs:
	@echo "==> Streaming logs for $(BUNDLE_ID)..."
	xcrun simctl spawn $(DEVICE_ID) log stream --predicate 'processImagePath contains "SwiftTodoApp"'

screenshot:
	@echo "==> Capturing screenshot..."
	mkdir -p build screenshots
	xcrun simctl io $(DEVICE_ID) screenshot build/screenshot.png
	cp build/screenshot.png screenshots/simulator-$$(date +%s).png

stop:
	@echo "==> Terminating $(BUNDLE_ID)..."
	-xcrun simctl terminate $(DEVICE_ID) $(BUNDLE_ID)

uninstall: stop
	@echo "==> Uninstalling $(BUNDLE_ID)..."
	-xcrun simctl uninstall $(DEVICE_ID) $(BUNDLE_ID)

clean:
	@echo "==> Cleaning build artifacts..."
	rm -rf .build build screenshots
