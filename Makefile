# HugMesh-matrix-ui — developer make targets.
#
# `make pentest` runs the repo-local OWASP pen-test self-scan that MIRRORS the
# centralized GitLab CI `pentest` stage (see .gitlab-ci.yml, which includes
# hugmesh-generator /tests/pentest/ci/pentest-stage.gitlab-ci.yml). It is
# self-contained and NON-fatal when tooling or a DAST target is absent, so it is
# safe to run anywhere.

# Where to find / clone the shared pen-test harness (DAST). Override as needed.
GENERATOR_REPO ?= https://github.com/hugmesh/hugmesh-generator.git
PENTEST_HARNESS_DIR ?= $(CURDIR)/.pentest-harness/tests/pentest
# Set DAST_TARGET_URL to a running env-test-build to drive the full DAST harness.
DAST_TARGET_URL ?=

.PHONY: pentest pentest-sca pentest-dast

# Full local pen-test = SCA (always) + DAST (only when a target URL is set).
pentest: pentest-sca pentest-dast

# SCA — Angular/npm repo. Mirrors the CI SCA posture: `npm audit` is the fast,
# always-available gate; OWASP Dependency-Check (what CI runs via the
# owasp/dependency-check image) is the authoritative scan and is run here too
# when its CLI is on PATH. Neither hard-fails the target.
pentest-sca:
	@echo "==> [pentest] SCA: npm audit (--audit-level=high)"
	@if [ -f package-lock.json ] || [ -f package.json ]; then \
		npm audit --audit-level=high || echo "   (npm audit reported findings; review above — non-fatal locally)"; \
	else \
		echo "   (no package.json/package-lock.json found; skipping npm audit)"; \
	fi
	@echo "==> [pentest] SCA: OWASP Dependency-Check (authoritative; matches CI)"
	@if command -v dependency-check.sh >/dev/null 2>&1; then \
		mkdir -p reports/sca; \
		dependency-check.sh --project "hugmesh-matrix-ui" --scan "." \
			--out "reports/sca" --enableExperimental \
			--format HTML --format JSON --failOnCVSS 9 \
			|| echo "   (dependency-check reported findings; review reports/sca — non-fatal locally)"; \
	else \
		echo "   (dependency-check CLI not installed; CI runs it via the owasp/dependency-check image:"; \
		echo "      docker run --rm -v \"$(CURDIR)\":/src owasp/dependency-check:latest \\"; \
		echo "        --project hugmesh-matrix-ui --scan /src --out /src/reports/sca --failOnCVSS 9 )"; \
	fi

# DAST — delegate to the shared generator harness (the SAME run-pentest.sh the CI
# `.pentest-dast-baseline` job drives, which runs the ZAP baseline + custom probes
# + nuclei). Only runs when DAST_TARGET_URL is set; clones the harness if missing.
pentest-dast:
	@if [ -z "$(DAST_TARGET_URL)" ]; then \
		echo "==> [pentest] DAST: skipped (set DAST_TARGET_URL=<running app url> to enable)"; \
	else \
		echo "==> [pentest] DAST: baseline against $(DAST_TARGET_URL) via shared harness"; \
		if [ ! -d "$(PENTEST_HARNESS_DIR)" ]; then \
			echo "   (harness not found; cloning $(GENERATOR_REPO) -> .pentest-harness)"; \
			git clone --depth 1 "$(GENERATOR_REPO)" "$(CURDIR)/.pentest-harness" \
				|| { echo "   (clone failed; cannot run DAST — non-fatal)"; exit 0; }; \
		fi; \
		if [ -x "$(PENTEST_HARNESS_DIR)/run-pentest.sh" ] || [ -f "$(PENTEST_HARNESS_DIR)/run-pentest.sh" ]; then \
			DAST_TARGET_URL="$(DAST_TARGET_URL)" \
				bash "$(PENTEST_HARNESS_DIR)/run-pentest.sh" --scan baseline --pipeline main \
				|| echo "   (DAST harness reported findings/errors; review out/pentest — non-fatal locally)"; \
		else \
			echo "   (run-pentest.sh not found under $(PENTEST_HARNESS_DIR); cannot run DAST — non-fatal)"; \
		fi; \
	fi
