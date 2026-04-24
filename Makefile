.PHONY: help init plan apply destroy kubeconfig argocd-password bootstrap-cluster

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

init:
	mkdir -p $(STATE_DIR)
	cd terraform && tofu init \
		-backend-config="path=$(STATE_DIR)/terraform.tfstate" \
		-reconfigure

# Stage 1: Deploy Talos cluster only (writes kubeconfig to envs/ENV/generated/)
cluster: init
	$(call tofu-with-secrets,apply -target=module.talos_cluster -target=local_sensitive_file.kubeconfig -target=local_sensitive_file.talosconfig -auto-approve)

# Stage 2: Deploy ArgoCD + ApplicationSet (requires cluster to be running)
platform: init
	$(call tofu-with-secrets,apply -var='deploy_platform_bootstrap=true' -auto-approve)

plan: init
	$(call tofu-with-secrets,plan -out=tfplan)

apply: init
	$(call tofu-with-secrets,apply -auto-approve)

destroy: init
	$(call tofu-with-secrets,destroy -auto-approve)

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

kubeconfig:
	mkdir -p ~/.kube
	./scripts/get-kubeconfig.sh $(ENV) ~/.kube/config-platform-$(ENV)
	@echo "✅ Kubeconfig: ~/.kube/config-platform-$(ENV)"
	@echo "   export KUBECONFIG=~/.kube/config-platform-$(ENV)"

talosconfig:
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

argocd-pass:
	KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl -n argocd get secret argocd-initial-admin-secret \
		-o jsonpath="{.data.password}" | base64 -d; echo

nodes:
	KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl get nodes -o wide

argocd-ui:
	@echo "ArgoCD UI: http://localhost:8080  (admin / see: make argocd-pass)"
	KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl port-forward svc/argocd-server -n argocd 8080:80

