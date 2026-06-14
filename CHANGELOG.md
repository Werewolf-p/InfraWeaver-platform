# Changelog

All notable changes to this repository should be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows a GitOps-friendly workflow where merged pull requests become the canonical change record.

## [Unreleased]

### Added
- _Document new features here._
- 2026-06-13: Verify init UI applied-update path (changelog + restart-to-new-build).

### Changed
- _Document behavior or workflow updates here._

### Fixed
- _Document bug fixes here._
- Init wizard: Cluster Topology step now counts `hybrid` nodes toward the control-plane minimum, so an all-hybrid cluster (even a single hybrid node) can proceed past "Continue".

### Removed
- _Document removals or deprecations here._

## Automation notes

- Keep this file updated from merged PR summaries or release automation.
- When adding release tooling later, prefer generating entries from conventional PR labels and titles.
- If a deployment changes Kubernetes manifests only, include both the user-facing impact and the affected app or namespace.
