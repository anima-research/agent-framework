- An MCPL server's `inference/request` on a host that sets no
  `inferenceRouting` policy is refused before it reaches the provider, with
  `-32603` and a message naming `inferenceRouting`. Before, it went to the
  provider with the model `default`, a name the Anthropic API doesn't
  recognize (its token-counting endpoint answers 404 `not_found_error` for
  it), and a failed inference comes back to the server as `-32603` with the
  provider's message. The framework doesn't choose a model for the server: a
  model it picked would run, on whatever credentials and at whatever price
  it carries, for a server the operator never chose it for. A host whose
  provider served a model named `default`, through a membrane
  `beforeRequest` hook, a proxy or another adapter, loses server inference
  until it sets `inferenceRouting`. The capability grant is unchanged.
- A policy that names no model for a request's feature set refuses that
  request the same way, naming the feature set, where it sent an empty
  model on to the provider. A policy entry that is empty or not a string
  names no model: an empty `wildcards` entry is passed over, as empty
  `byFeature` and `overrides` entries already were, and an override or
  feature set named like an `Object.prototype` member (such as
  `constructor`) no longer reads one.
- Each refusal is traced as `mcpl:inference_fail`, with `model: null` and
  no `mcpl:inference_start`, so a trace watcher still sees the failure it saw
  when the request failed at the provider. The first refusal for each server
  is logged, naming what to set; with a policy, so is the first for each
  feature set it names no model for.
