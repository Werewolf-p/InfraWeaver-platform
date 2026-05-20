terraform {
  # Local backend — state path is configured at init time via -backend-config.
  # See envs/ENV/backend.hcl for per-environment state path configuration.
  #
  # Init command:
  #   cd terraform
  #   tofu init -backend-config="../envs/ontwikkel/backend.hcl"   # dev
  #   tofu init -backend-config="../envs/productie/backend.hcl"   # prod
  backend "local" {}
}
