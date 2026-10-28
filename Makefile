# Amphibian Launcher build.
#
# The build is split into cacheable stages. Everything that is downloaded once
# (the prebuilt statics) or produced by the heavy .NET/AOT compiler is guarded
# by a stamp, so a second `make build` after only touching the frontend does
# not re-download ~430 MB or re-run the wasm toolchain.
#
# Useful knobs:
#   AOT=false (default)  fast builds; AOT=true for release/FPS
#   OPT=false (default)  skip wasm-opt (very slow, small size win)
#   AOT_JAVA=false       opt-in profile-only AOT for IKVM.Java (see aotprofile/)
#   make -j$(nproc)      parallel statics downloads
#   make single          one self-contained index.html in frontend/dist-single

SHELL := /bin/bash
.DELETE_ON_ERROR:
.DEFAULT_GOAL := build

STATICS_RELEASE=f436b72b-adfb-4c28-9cd7-8e2493f8e815
IKVM_RELEASE=b9449e8c-10b5-49aa-a57a-365348d837fe
DOTNETFLAGS=--nodereuse:false -v n
AOT ?= false
OPT ?= false
# Profile-only AOT for IKVM.Java. Off by default: it improves JDK-heavy code but
# costs extra compile time and needs a generated profile (see `make aot-java`).
AOT_JAVA ?= false
AOT_PROFILE_FILE ?= aotprofile/ikvm-java.txt
AOT_PROFILE_FILTERS ?=

STATICS := statics

ifeq ($(AOT_JAVA),true)
JAVA_AOT_PROFILE := $(abspath $(STATICS)/ikvm/ikvm-java.aotprofile)
JAVA_AOT_ARGS := -p:IkvmJavaAotProfile=$(JAVA_AOT_PROFILE)
else
JAVA_AOT_PROFILE :=
JAVA_AOT_ARGS :=
endif

NPROC := $(shell nproc 2>/dev/null || echo 4)
CURL := curl -fL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 30 --progress-bar

STATICS_DIR_STAMP := $(STATICS)/.dir
DOTNET_ZIP := $(STATICS)/dotnet.zip
EMSDK_ZIP := $(STATICS)/emsdk.zip
IKVM_ZIP := $(STATICS)/ikvm.zip
WINK_ZIP := $(STATICS)/wink-js.zip

SDL3 := $(STATICS)/SDL3.a
OPENAL := $(STATICS)/libopenal.a
GLFW := $(STATICS)/libglfw3.a
GLFW_JS := $(STATICS)/lib_emscripten_glfw3.js
WINK := $(STATICS)/libwink.a
WINK_WEBGPU := $(STATICS)/libwink_webgpu.a
WINK_TINT := $(STATICS)/libwink_tint.a
LWJGL_JAR := $(STATICS)/lwjgl3.jar
LWJGL := $(STATICS)/liblwjgl3.a
LWJGL_STB := $(STATICS)/liblwjgl_stb.a
FFI := $(STATICS)/libffi.a

UNZIP_STAMPS := \
	$(STATICS)/.unzip-dotnet \
	$(STATICS)/.unzip-emsdk \
	$(STATICS)/.unzip-ikvm \
	$(STATICS)/.unzip-wink-js

STATIC_FILES := \
	$(SDL3) $(OPENAL) $(GLFW) $(GLFW_JS) $(WINK) $(WINK_WEBGPU) $(WINK_TINT) \
	$(LWJGL_JAR) $(LWJGL) $(LWJGL_STB) $(FFI)

PUBLISH_DIR := loader/bin/Release/net10.0/publish/wwwroot
PUBLISH_STAMP := $(STATICS)/.loader-publish.stamp
FRAMEWORK_STAMP := $(STATICS)/.frontend-framework.stamp
MODE_FILE := $(STATICS)/.build-mode
IKVMC_STAMP := $(STATICS)/.ikvmc.stamp

FRAMEWORK_DIR := frontend/public/_framework
IMAGE_DIR := frontend/public/image
FRONTEND_DEPS_STAMP := frontend/node_modules/.modules.yaml

LOADER_SOURCES := $(shell find loader aotprofile -type d \( -name bin -o -name obj \) -prune -o -type f \
	\( -name '*.cs' -o -name '*.csproj' -o -name '*.c' -o -name '*.h' -o -name '*.targets' \
	   -o -name '*.props' -o -name '*.java' -o -name '*.json' -o -name '*.sh' \) -print 2>/dev/null)
LOADER_SOURCES += $(wildcard aotprofile/*.txt)

.PHONY: all statics ikvmc-bundles deps deps-frontend build serve publish serve-publish single clean dotnetclean ikvmclean aot-java help

all: build

help:
	@sed -n '2,20p' Makefile | sed 's/^# \{0,1\}//'

$(STATICS_DIR_STAMP):
	@mkdir -p $(STATICS)
	@touch $@

# ---- downloads (cached by file existence; re-run only if a file is missing) ----

$(DOTNET_ZIP): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/FNA-WASM-Build/releases/download/$(STATICS_RELEASE)/dotnet-jspi-jit.zip
	unzip -tq $@.part >/dev/null
	mv $@.part $@

$(EMSDK_ZIP): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/FNA-WASM-Build/releases/download/$(STATICS_RELEASE)/emsdk.zip
	unzip -tq $@.part >/dev/null
	mv $@.part $@

$(IKVM_ZIP): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/ikvm-wasm-bundle.zip
	unzip -tq $@.part >/dev/null
	mv $@.part $@

$(WINK_ZIP): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/wink-js-mt.zip
	unzip -tq $@.part >/dev/null
	mv $@.part $@

$(SDL3): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/FNA-WASM-Build/releases/download/$(STATICS_RELEASE)/SDL3.a && mv $@.part $@

$(OPENAL): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/FNA-WASM-Build/releases/download/$(STATICS_RELEASE)/libopenal.a && mv $@.part $@

$(GLFW): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/libglfw3-mt.a && mv $@.part $@

$(GLFW_JS): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/lib_emscripten_glfw3-mt.js && mv $@.part $@

$(WINK): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/libwink-mt.a && mv $@.part $@

$(WINK_WEBGPU): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/libwink_webgpu-mt.a && mv $@.part $@

$(WINK_TINT): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/libwink_tint-mt.a && mv $@.part $@

$(LWJGL_JAR): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/lwjgl3-mt.jar && mv $@.part $@

$(LWJGL): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/liblwjgl3-mt.a && mv $@.part $@

$(LWJGL_STB): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/liblwjgl_stb-mt.a && mv $@.part $@

$(FFI): | $(STATICS_DIR_STAMP)
	$(CURL) -o $@.part https://github.com/r58Playz/IKVM-WASM-Build/releases/download/$(IKVM_RELEASE)/libffi-mt.a && mv $@.part $@

statics: $(UNZIP_STAMPS) $(STATIC_FILES)

$(STATICS)/.unzip-dotnet: $(DOTNET_ZIP)
	rm -rf $(STATICS)/dotnet
	unzip -q -o $< -d $(STATICS)/dotnet
	touch $@

$(STATICS)/.unzip-emsdk: $(EMSDK_ZIP)
	rm -rf $(STATICS)/emsdk
	unzip -q -o $< -d $(STATICS)
	touch $@

$(STATICS)/.unzip-ikvm: $(IKVM_ZIP)
	rm -rf $(STATICS)/ikvm
	unzip -q -o $< -d $(STATICS)/ikvm
	touch $@

$(STATICS)/.unzip-wink-js: $(WINK_ZIP)
	rm -rf $(STATICS)/wink-js
	unzip -q -o $< -d $(STATICS)/wink-js
	touch $@

# ---- IKVM bundles (small; ikvmc.sh itself skips outputs that already exist) ----

ikvmc-bundles: statics
	@# The stamp lives in statics/ (which CI caches), but Generated.targets and
	@# the manifest live in loader/ (which it does not). Rebuild them if any of
	@# the stamp's outputs are missing instead of trusting a restored stamp.
	@if [ ! -f loader/Generated.targets ] || [ ! -f loader/ikvmc-manifest.g.json ] \
		|| ! compgen -G 'jars/ikvmc_*.dll' >/dev/null \
		|| ! compgen -G 'statics/ikvmc_*.dll' >/dev/null; then \
		rm -f $(IKVMC_STAMP); \
	fi
	@$(MAKE) --no-print-directory $(IKVMC_STAMP)

$(IKVMC_STAMP): build-ikvmc.py ikvmc.sh $(STATICS)/.unzip-ikvm $(STATICS)/.unzip-dotnet
	rm -f $(STATICS)/ikvmc_*.dll $(STATICS)/ikvmc_*.pdb jars/ikvmc_*.dll jars/ikvmc_*.pdb
	python3 build-ikvmc.py all
	touch $@

deps: statics ikvmc-bundles

# ---- frontend dependencies ----

$(FRONTEND_DEPS_STAMP): frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml vendor/dreamland-0.1.3.tgz
	cd frontend && pnpm install
	@touch $@

deps-frontend: $(FRONTEND_DEPS_STAMP)

# ---- .NET / WASM publish ----
#
# Only re-runs when loader sources, statics, or the AOT/OPT mode change. The
# publish directory is wiped first so renamed/removed framework files cannot
# leak into the next build; the expensive obj/ intermediates are untouched.

$(PUBLISH_STAMP): $(LOADER_SOURCES) $(UNZIP_STAMPS) $(STATIC_FILES) $(IKVMC_STAMP) $(JAVA_AOT_PROFILE)
	rm -rf $(PUBLISH_DIR)
	dotnet publish loader/IkvmWasm.csproj -c Release \
		-p:IkvmWasmEnableAot=$(AOT) \
		-p:IkvmWasmEnableWasmOpt=$(OPT) \
		$(JAVA_AOT_ARGS) \
		$(DOTNETFLAGS)
	touch $@

# Copy the publish output into frontend/public and split oversized resources.
# Runs only when the publish stamp is newer (or the build mode changed).
$(FRAMEWORK_STAMP): $(PUBLISH_STAMP) split-resources.py frontend/src/dotnet/resources.js
	rm -rf $(FRAMEWORK_DIR)
	cp -a $(PUBLISH_DIR)/_framework $(FRAMEWORK_DIR)
	rm -rf $(IMAGE_DIR)
	cp -a $(STATICS)/ikvm/image $(IMAGE_DIR)
	# dotnet's runtime has a 32 KiB cap on the wasm memory page count; this raises it to 64 KiB.
	sed -i 's/this.appendULeb(32768)/this.appendULeb(65535)/' $(FRAMEWORK_DIR)/dotnet.runtime.*.js
	python3 split-resources.py frontend/public
	touch $@

# The mode check is cheap and makes switching AOT/OPT safe even though the
# stamps are mode-independent (otherwise a stale AOT publish could be reused
# for a non-AOT build and vice versa).
build: ikvmc-bundles
	@mkdir -p $(STATICS)
	@want="AOT=$(AOT) OPT=$(OPT) AOT_JAVA=$(AOT_JAVA)"; \
	if [ "$$(cat $(MODE_FILE) 2>/dev/null)" != "$$want" ]; then \
		echo "$$want" > $(MODE_FILE); \
		rm -f $(PUBLISH_STAMP) $(FRAMEWORK_STAMP); \
	fi
	@# A restored stamp must not hide missing outputs (CI caches statics but not
	@# frontend/public, and Docker only caches parts of loader/).
	@if [ ! -f $(PUBLISH_DIR)/_framework/dotnet.js ]; then rm -f $(PUBLISH_STAMP) $(FRAMEWORK_STAMP); fi
	@if [ ! -f frontend/public/_framework/dotnet.js ] || [ ! -d frontend/public/image ]; then rm -f $(FRAMEWORK_STAMP); fi
	@$(MAKE) --no-print-directory $(FRAMEWORK_STAMP)

serve: build
	cd frontend && pnpm dev

publish: build deps-frontend
	cd frontend && pnpm build

# One self-contained HTML. Requires a host that sends COOP/COEP headers
# (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy:
# require-corp); a service worker cannot be embedded in a single file.
single: build deps-frontend
	cd frontend && pnpm exec tsc && SINGLE_FILE=1 pnpm exec vite build --outDir dist-single
	node scripts/singlefile.mjs frontend/dist-single

serve-publish: publish
	cd frontend && pnpm preview

# Optional: generate a profile-only AOT profile for IKVM.Java. This is a
# targeted FPS win for hot JDK classes, not a default: generate a profile, then
# build with AOT=true AOT_JAVA=true. Provide filters inline or in a file:
#   make aot-java AOT_PROFILE_FILTERS='java.util. java.util.zip. sun.nio.ch.'
#   make aot-java AOT_PROFILE_FILE=aotprofile/ikvm-java.txt
aot-java: statics
	@mkdir -p $(STATICS)/ikvm
	@set -e; \
	if [ -n "$(AOT_PROFILE_FILTERS)" ]; then \
		./aotprofile.sh $(abspath $(STATICS)/ikvm/ikvm-java.aotprofile) $(abspath $(STATICS)/ikvm/IKVM.Java.dll) $(AOT_PROFILE_FILTERS); \
	elif [ -f "$(AOT_PROFILE_FILE)" ]; then \
		./aotprofile.sh $(abspath $(STATICS)/ikvm/ikvm-java.aotprofile) $(abspath $(STATICS)/ikvm/IKVM.Java.dll) "@$(abspath $(AOT_PROFILE_FILE))"; \
	else \
		echo "usage: make aot-java AOT_PROFILE_FILTERS='<type-prefix> ...'"; \
		echo "   or: create $(AOT_PROFILE_FILE) (one exact type per line) and re-run"; \
		exit 2; \
	fi

dotnetclean:
	rm -rf statics/dotnet loader/bin loader/obj loader/Generated.targets loader/ikvmc-manifest.g.json \
		$(STATICS)/.unzip-dotnet $(PUBLISH_STAMP) $(FRAMEWORK_STAMP) $(MODE_FILE)

ikvmclean:
	rm -rf statics/ikvm statics/wink-js $(STATICS)/ikvmc_*.dll $(STATICS)/ikvmc_*.pdb \
		jars/ikvmc_*.dll jars/ikvmc_*.pdb $(STATICS)/*.aotprofile $(STATICS)/*.aotprofile.stamp \
		$(STATICS)/.unzip-ikvm $(STATICS)/.unzip-wink-js $(IKVMC_STAMP) $(MODE_FILE)
	rm -f loader/Generated.targets loader/ikvmc-manifest.g.json

clean: dotnetclean ikvmclean
	rm -rf statics frontend/dist frontend/dist-single frontend/public/_framework frontend/public/image
