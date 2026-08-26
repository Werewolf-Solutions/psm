# Managed deployment ADRs

These records close the adapter choices intentionally left open by
[`DEPLOYMENT-SYSTEM.md`](../DEPLOYMENT-SYSTEM.md). They constrain implementations; a provider or
packaging change requires a new superseding ADR rather than an unnoticed edit to an existing
contract.

- [ADR-0001: Better Stack supplies external Watch](0001-better-stack-watch.md)
- [ADR-0002: Native OS keyrings persist local secrets](0002-native-os-keyring.md)
- [ADR-0003: The privileged host helper is a static Go service](0003-static-go-host-helper.md)
- [ADR-0004: Controller revisions are immutable release tags](0004-controller-revisions.md)
- [ADR-0005: Retain artifacts for 30 days and five target releases](0005-release-retention.md)
