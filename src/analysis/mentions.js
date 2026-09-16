function normalized(value) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function findAliases(text, aliases = []) {
  const haystack = normalized(text);
  return aliases.filter((alias) => alias && haystack.includes(normalized(alias)));
}

/** Deterministic substring matching only; no semantic inference or disambiguation. */
export function detectMentions(answerText, { brand, competitors = [] } = {}) {
  const brandAliases = brand ? [brand.name, ...(brand.aliases ?? [])] : [];
  const brandHits = findAliases(answerText, brandAliases);
  const competitorHits = competitors
    .map((competitor) => ({
      name: competitor.name,
      hits: findAliases(answerText, [competitor.name, ...(competitor.aliases ?? [])])
    }))
    .filter(({ hits }) => hits.length > 0);
  return {
    brand_mentioned: brandHits.length > 0,
    brand_hits: brandHits,
    competitor_mentions: competitorHits
  };
}
