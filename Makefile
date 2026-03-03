.PHONY: build test check upstream install clean

# Compile oc-observe and ca-gen from C source
build:
	bun run script/postinstall.ts

# Install deps + compile binaries
install:
	bun install

# Run test suite
test:
	bun test

# Typecheck
check:
	bun run typecheck

# Pull latest opencode release tag, rebase patch, rebuild + deploy
upstream:
	~/.local/bin/oc-build update

# Rebuild patched opencode from current state (no upstream pull)
rebuild:
	~/.local/bin/oc-build

# Remove compiled binaries
clean:
	rm -rf bin/oc-observe bin/ca-gen bin/ca.pem bin/ca.key bin/oc-epilogue
