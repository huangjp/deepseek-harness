---
kind: upgrade-guide
description: "Session model selection gained a routing mode, and the model-selection RPC request and response changed shape."
---

# Session model selection carries a routing mode

English | [中文](guide.zh.md)

## Change

A Session now records a routing mode. `auto` leaves the route to the Host's routing policy; `fixed` pins the model the Session selected, so no router answers with another route. A Session that recorded no mode follows the deployment's default, which is `auto` unless the profile sets `agent-default-model.routingMode`.

`session.selectModel` accepts a mode-only request: `provider` and `model` are optional now, and a request carrying only `routingMode` changes who picks the route without naming one. A request that names a route still applies that route and also switches the Session to `fixed`. The response gains `routingMode` and reports `selected: null` for a mode-only request. `session.modelCatalog` gains `defaultRoutingMode` and `routingAvailable`.

The `modelSelection` projection view gains `routingMode`, and a new `model/routing-mode` Session event records the mode. Consumers that decode the projection view as an exact object must accept the new field.

## Migration

1. Update every consumer of `session.selectModel` to treat `provider` and `model` as optional and to read `routingMode` from the response. A request that sends both a route and `routingMode` gets the route applied and the mode pinned to `fixed`.
2. Update every consumer of the `modelSelection` projection view to carry the new `routingMode` field, and to read `defaultRoutingMode` and `routingAvailable` from `session.modelCatalog`. `routingAvailable` is `false` on a Host without a routing plugin, and such a Host behaves as if every Session were pinned.
3. Confirm that a mode-only `session.selectModel` returns `{ selected: null, routingMode: 'auto' }` and that the next request is answered by the routing policy, while naming a route returns `{ selected, routingMode: 'fixed' }` and keeps that route.
