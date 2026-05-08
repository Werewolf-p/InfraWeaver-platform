.PHONY: help init plan apply destroy cluster platform kubeconfig talosconfig \
        argocd-pass nodes argocd-ui \
        bootstrap push-secrets validate fmt lint lint-yaml lint-helm lint-actions \
        new-app new-user test docs \
        validate-platform validate-users validate-all \
        status apps diff users-list install-dev-tools clean

ENV       ?= ontwikkel
STATE_DIR := $(HOME)/.tofu/state/platform-$(ENV)
SECRETS   := envs/$(ENV)/secrets.sops.yaml
TFVARS    := envs/$(ENV)/terraform.tfvars

help:
	@echo "InfraWeaver Platform — Talos + ArgoCD on Proxmox"
	@echo ""
	@echo "Usage:  make <target> ENV=<ontwikkel|productie>"
	@echo ""
	@echo "Deployment workflow:"
	@echo "  1. make init         Initialize OpenTofu for the target environment"
	@echo "  2. make cluster      Deploy Talos cluster (stage 1)"
	@echo "  3. make platform     Deploy ArgoCD + ApplicationSet (stage 2)"
	@echo "  4. make kubeconfig   Export kubeconfig to ~/.kube/"
	@echo ""
	@echo "Shortcuts:"
	@echo "  make plan            Plan infrastructure changes (full)"
	@echo "  make apply           Apply all changes (full)"
	@echo "  make destroy         Destroy all platform infrastructure"
	@echo ""
	@echo "Operations:"
	@echo "  make kubeconfig      Export kubeconfig to ~/.kube/config-platform-<env>"
	@echo "  make talosconfig     Export talosconfig to ~/.talos/config-platform-<env>"
	@echo "  make argocd-pass     Get ArgoCD initial admin password"
	@echo "  make nodes           Show cluster nodes (kubectl)"
	@echo "  make argocd-ui       Port-forward ArgoCD UI to localhost:8080"
	@echo ""
	@echo "Secrets (SOPS/age):"
	@echo "  export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt"
	@echo "  sops --encrypt --in-place $(SECRETS)"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Run a tofu command with secrets decrypted from SOPS into the environment.
# Falls back to env vars already set if secrets.sops.yaml is absent.
define tofu-with-secrets
	@if [ -f "$(SECRETS)" ] && which sops >/dev/null 2>&1; then \
		echo "==> Decrypting secrets from $(SECRETS)..."; \
		sops exec-env "$(SECRETS)" \
			"cd terraform && tofu $(1) -var-file='../$(TFVARS)'"; \
	else \
		echo "WARN: SOPS secrets not found or sops not installed. Using env vars."; \
		cd terraform && tofu $(1) -var-file='../$(TFVARS)'; \
	fi
endef

# ---------------------------------------------------------------------------
# Core targets
# ---------------------------------------------------------------------------

init: ## Initialize OpenTofu backend for the target environment
	mkdir -p $(STATE_DIR)
	cd terraform && tofu init \
		-backend-config="path=$(STATE_DIR)/terraform.tfstate" \
		-reconfigure

# Stage 1: Deploy Talos cluster only (writes kubeconfig to envs/ENV/generated/)
cluster: init ## Deploy Talos cluster (stage 1 of 2)
	$(call tofu-with-secrets,apply -target=module.talos_cluster -target=local_sensitive_file.kubeconfig -target=local_sensitive_file.talosconfig -auto-approve)

# Stage 2: Deploy ArgoCD + ApplicationSet (requires cluster to be running)
platform: init ## Deploy ArgoCD platform (stage 2 of 2; requires cluster)
	$(call tofu-with-secrets,apply -var='deploy_platform_bootstrap=true' -auto-approve)

plan: init ## Preview OpenTofu changes (writes tfplan)
	$(call tofu-with-secrets,plan -out=tfplan)

apply: init ## Apply OpenTofu changes to the target environment
	$(call tofu-with-secrets,apply -auto-approve)

destroy: init ## Destroy all OpenTofu-managed resources (⚠ destructive)
	$(call tofu-with-secrets,destroy -auto-approve)

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

kubeconfig: ## Fetch kubeconfig for ENV and write to ~/.kube/config-platform-ENV
	mkdir -p ~/.kube
	./scripts/get-kubeconfig.sh $(ENV) ~/.kube/config-platform-$(ENV)
	@echo "✅ Kubeconfig: ~/.kube/config-platform-$(ENV)"
	@echo "   export KUBECONFIG=~/.kube/config-platform-$(ENV)"

talosconfig: ## Fetch talosconfig for ENV and write to ~/.talos/config-platform-ENV
	mkdir -p ~/.talos
	@if [ -f "envs/$(ENV)/generated/talosconfig" ]; then \
		cp envs/$(ENV)/generated/talosconfig ~/.talos/config-platform-$(ENV); \
		chmod 600 ~/.talos/config-platform-$(ENV); \
		echo "✅ Talosconfig: ~/.talos/config-platform-$(ENV)"; \
		echo "   export TALOSCONFIG=~/.talos/config-platform-$(ENV)"; \
	else \
		echo "ERROR: envs/$(ENV)/generated/talosconfig not found."; \
		echo "       Run 'make cluster ENV=$(ENV)' first."; \
		exit 1; \
	fi

argocd-pass: ## Print the ArgoCD initial admin password (base64-decoded)
	@KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl -n argocd get secret argocd-initial-admin-secret \
		-o jsonpath="{.data.password}" | base64 -d; echo

nodes: ## Show all Kubernetes nodes (wide output)
	KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl get nodes -o wide

argocd-ui: ## Port-forward ArgoCD UI to localhost:8080
	@echo "ArgoCD UI: http://localhost:8080  (admin / see: make argocd-pass)"
	KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl port-forward svc/argocd-server -n argocd 8080:80


# ---------------------------------------------------------------------------
# Developer Experience — Bootstrap & Local Setup
# ---------------------------------------------------------------------------

bootstrap: ## Validate local dev environment (tools, .env, SOPS, tofu)
	@bash scripts/bootstrap-local.sh

push-secrets: ## Sync .env → GitHub Secrets using gh CLI
	@bash scripts/push-secrets-to-github.sh

validate: ## Run tofu validate (no network/state needed)
	@echo "==> Running tofu validate..."
	@cd terraform && tofu init -backend=false -no-color -input=false >/dev/null 2>&1 && tofu validate

fmt: ## Format all Terraform files in-place
	@echo "==> Formatting Terraform..."
	@tofu fmt -recursive terraform/

# ---------------------------------------------------------------------------
# Linting
# ---------------------------------------------------------------------------

lint: lint-yaml lint-helm lint-actions ## Run all linters

lint-yaml: ## Lint all YAML files with yamllint
	@if command -v yamllint >/dev/null 2>&1; then \
	echo "==> Running yamllint..."; \
	yamllint -c .yamllint.yaml kubernetes/ || true; \
else \
	echo "WARN: yamllint not found — install: pip install yamllint"; \
fi

lint-helm: ## Check Helm chart values files exist alongside application.yaml
	@echo "==> Checking Helm app structure..."; \
FAIL=0; \
for dir in kubernetes/core/*/ kubernetes/apps/*/ kubernetes/monitoring/*/; do \
	if [ -f "$${dir}application.yaml" ] && [ ! -f "$${dir}values.yaml" ]; then \
	echo "  WARN: $${dir} has application.yaml but no values.yaml"; \
	fi; \
done; \
echo "  Helm structure check complete"

lint-actions: ## Lint GitHub Actions workflows with actionlint
	@if command -v actionlint >/dev/null 2>&1; then \
	echo "==> Running actionlint..."; \
	actionlint .github/workflows/*.yml; \
else \
	echo "WARN: actionlint not found — https://github.com/rhysd/actionlint/releases"; \
fi

# ---------------------------------------------------------------------------
# Scaffolding — New App / New User
# ---------------------------------------------------------------------------

new-app: ## Scaffold a new K8s app: make new-app NAME=myapp TIER=apps
	@if [ -z "$(NAME)" ]; then \
	echo "Usage: make new-app NAME=<app-name> [TIER=apps|core|monitoring]"; \
	exit 1; \
fi
	@bash scripts/new-app.sh "$(NAME)" "$(or $(TIER),apps)"

new-user: ## Guide for adding a new platform user: make new-user USER=alice NAME="Alice" EMAIL=a@b.com LEVEL=platform-user
	@if [ -z "$(USER)" ]; then \
	echo "Usage: make new-user USER=<username> NAME='<Full Name>' EMAIL=<email> [LEVEL=admin|platform-user]"; \
	exit 1; \
fi
	@bash scripts/new-user.sh "$(USER)" "$(or $(NAME),$(USER))" "$(EMAIL)" "$(or $(LEVEL),platform-user)"

# ---------------------------------------------------------------------------
# Testing
# ---------------------------------------------------------------------------

test: ## Run post-deploy test suite against live cluster
	@KB=~/.kube/config-platform-$(ENV); \
if [ ! -f "$$KB" ]; then \
	echo "Kubeconfig not found at $$KB"; \
	echo "Run: bash scripts/get-kubeconfig.sh $(ENV)"; \
	exit 1; \
fi; \
bash scripts/test-post-deploy.sh "$$KB" "$(ENV)"

# ---------------------------------------------------------------------------
# Documentation
# ---------------------------------------------------------------------------

docs: ## Generate Terraform module README.md files (requires terraform-docs)
	@if command -v terraform-docs >/dev/null 2>&1; then \
	for mod in terraform/modules/*/; do \
	echo "==> Generating docs for $${mod}..."; \
	terraform-docs markdown table --output-file README.md "$${mod}" || true; \
	done; \
else \
	echo "WARN: terraform-docs not found — https://terraform-docs.io"; \
fi

# ---------------------------------------------------------------------------
# Schema Validation — platform.yaml + users.yaml
# ---------------------------------------------------------------------------

validate-platform: ## Validate platform.yaml (checks all enabled apps have catalog dirs)
	@bash scripts/validate-platform-yaml.sh

validate-users: ## Validate users.yaml (required fields, valid access_level values)
	@bash scripts/validate-users-yaml.sh

validate-all: validate validate-platform validate-users ## Run all validations

# ---------------------------------------------------------------------------
# Cluster Status
# ---------------------------------------------------------------------------

status: ## Show ArgoCD application health and sync status
	@KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl get applications -n argocd \
		-o custom-columns="NAME:.metadata.name,HEALTH:.status.health.status,SYNC:.status.sync.status" \
		--sort-by=.metadata.name 2>/dev/null || \
		echo "Cannot reach cluster — run: make kubeconfig ENV=$(ENV)"

apps: ## List all deployed ArgoCD applications with repo URL
	@KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl get applications -n argocd \
		-o custom-columns="APP:.metadata.name,HEALTH:.status.health.status,SYNC:.status.sync.status" \
		2>/dev/null | sort || echo "Cannot reach cluster"

diff: ## Show kubernetes manifest diff vs live cluster
	@echo "→ Diffing kubernetes/ against cluster $(ENV)..."
	@find kubernetes/ -name "*.yaml" ! -name "values.yaml" ! -path "*/templates/*" -type f \
		-exec KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl diff -f {} \; 2>/dev/null || true

users-list: ## List all users from users.yaml
	@python3 -c "import yaml; \
		users = yaml.safe_load(open('users.yaml'))['users']; \
		print(f'  {\"USERNAME\":<20} {\"EMAIL\":<35} ROLE'); \
		print('  ' + '-'*70); \
		[print(f'  {u:<20} {d.get(\"email\",\"\")<35} {d.get(\"access_level\",\"\")}') for u,d in users.items()]"

# ---------------------------------------------------------------------------
# Developer Tools Install
# ---------------------------------------------------------------------------

install-dev-tools: ## Install local developer tools (yamllint, kubeconform, pre-commit)
	@echo "→ Installing local dev tools..."
	@pip install --quiet yamllint pre-commit 2>/dev/null && echo "  ✅ yamllint + pre-commit" || true
	@if ! command -v kubeconform >/dev/null 2>&1; then \
		KVER=v0.6.7; \
		mkdir -p $$HOME/.local/bin; \
		curl -fsSL "https://github.com/yannh/kubeconform/releases/download/$$KVER/kubeconform-linux-amd64.tar.gz" \
			| tar -xzf - -C $$HOME/.local/bin/ kubeconform 2>/dev/null; \
		echo "  ✅ kubeconform installed"; \
	else \
		echo "  ✅ kubeconform already installed"; \
	fi
	@if command -v pre-commit >/dev/null 2>&1 && [ -f .pre-commit-config.yaml ]; then \
		pre-commit install --quiet && echo "  ✅ pre-commit hooks installed"; \
	fi
	@echo "✅ Dev tools ready — run: make validate-all"

clean: ## Remove __pycache__ and temp files
	@find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	@find . -name "*.pyc" -delete 2>/dev/null || true
	@find . -name ".DS_Store" -delete 2>/dev/null || true
	@echo "✅ Cleaned"
