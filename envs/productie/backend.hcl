# Backend configuration for the productie environment.
# Pass to tofu init with:
#   tofu -chdir=terraform init -backend-config="../envs/productie/backend.hcl"
path = "~/.tofu/state/platform-productie/terraform.tfstate"
