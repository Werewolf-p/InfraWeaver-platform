.PHONY: help init plan apply destroy kubeconfig argocd-password

ENV ?= ontwikkel
STATE_DIR := $(HOME)/.tofu/state/platform-$(ENV)

help:
	@echo "InfraWeaver Platform — Talos + ArgoCD on Proxmox"
	@echo ""
	@echo "Usage:  make <target> ENV=<ontwikkel|productie>"
	@echo ""
	@echo "  init          Initialize OpenTofu"
	@echo "  plan          Plan infrastructure changes"
	@echo "  apply         Apply infrastructure (deploy cluster)"
	@echo "  destroy       Destroy all platform infrastructure"
	@echo "  kubeconfig    Export kubeconfig to ~/.kube/config-platform-<env>"
	@echo "  argocd-pass   Get ArgoCD initial admin password"
	@echo "  nodes         Show cluster nodes (kubectl)"
	@echo "  argocd-ui     Port-forward ArgoCD UI to localhost:8080"

init:
	mkdir -p $(STATE_DIR)
	cd terraform && tofu init \
		-backend-config="path=$(STATE_DIR)/terraform.tfstate" \
		-reconfigure

plan: init
	cd terraform && tofu plan \
		-var-file=../envs/$(ENV)/terraform.tfvars \
		-out=tfplan

apply: init
	cd terraform && tofu apply \
		-var-file=../envs/$(ENV)/terraform.tfvars \
		-auto-approve

destroy: init
	cd terraform && tofu destroy \
		-var-file=../envs/$(ENV)/terraform.tfvars \
		-auto-approve

kubeconfig:
	mkdir -p ~/.kube
	cd terraform && tofu output -raw kubeconfig > ~/.kube/config-platform-$(ENV)
	chmod 600 ~/.kube/config-platform-$(ENV)
	@echo "✅ Kubeconfig: ~/.kube/config-platform-$(ENV)"
	@echo "   export KUBECONFIG=~/.kube/config-platform-$(ENV)"

argocd-pass:
	KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl -n argocd get secret argocd-initial-admin-secret \
		-o jsonpath="{.data.password}" | base64 -d; echo

nodes:
	KUBECONFIG=~/.kube/config-platform-$(ENV) kubectl get nodes -o wide

argocd-ui:
	@echo "ArgoCD UI: http://localhost:8080"
	KUBECONFIG=~/.kube/config-platform-$(ENV) \
		kubectl port-forward svc/argocd-server -n argocd 8080:80
