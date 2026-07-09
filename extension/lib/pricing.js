// Sticker prices in USD per million tokens, cached from the Anthropic pricing
// docs (2026-06). Sonnet 5 has introductory pricing ($2/$10) through 2026-08-31;
// we display the sticker rate, so estimates are conservative until then.
export const PRICES = [
  { match: 'claude-sonnet-5', input: 3, output: 15 },
  { match: 'claude-opus-4-8', input: 5, output: 25 },
  { match: 'claude-haiku-4-5', input: 1, output: 5 },
];

export function estimateCost(model, inputTokens, outputTokens) {
  const price = PRICES.find((p) => String(model).startsWith(p.match));
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

export function formatUsage(usage, model) {
  const tokens =
    `${Number(usage.input).toLocaleString()} in / ${Number(usage.output).toLocaleString()} out tokens`;
  const cost = estimateCost(model, usage.input, usage.output);
  return cost === null ? tokens : `${tokens} · ~$${cost.toFixed(4)}`;
}
