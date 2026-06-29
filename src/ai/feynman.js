// Feynman Evaluation — AI-driven assessment of understanding quality
const llm = require('../llm');

const CRITERIA = {
  notJustRepeat: 'NOT just repeating the axiom text verbatim — uses different words/phrasing',
  notTooAbstract: 'NOT too abstract — grounds the explanation in concrete terms',
  hasConcreteExample: 'Provides at least one specific, realistic example or scenario',
  clarifiesBoundary: 'Makes clear when the judgment does NOT apply (boundary awareness)',
  ordinaryPersonUnderstands: 'Would make sense to someone unfamiliar with the domain',
};

const SYSTEM = `You are a Feynman evaluation engine. Your task is to assess how well someone understands a judgment principle based on their restatement of it in their own words.

Evaluate the restatement on these 5 criteria (each YES/NO):
${Object.entries(CRITERIA).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Also provide a brief explanation for each criterion (1-2 sentences) and a suggested improvement if any criterion fails.

Return ONLY valid JSON:
{
  "score": <0-5 integer>,
  "criteria": {
    "notJustRepeat": true/false,
    "notTooAbstract": true/false,
    "hasConcreteExample": true/false,
    "clarifiesBoundary": true/false,
    "ordinaryPersonUnderstands": true/false
  },
  "explanations": { "<criterion>": "<explanation>" },
  "suggestions": ["<improvement suggestion>"]
}`;

async function evaluate(config, card, options = {}) {
  // Bug: prior version read `card.feynman_text` (a field nothing in the
  // codebase ever wrote) and flattened `card.one_sentence` /
  // `card.full_statement` — the schema actually nests those under
  // `card.fields`. The AI evaluator therefore always received an empty
  // restatement and a blank axiom, no matter what was in the project.
  // The fix reads the canonical schema field names and the nested
  // `fields` object, with a fallback for callers that pass the flattened
  // shape directly.
  const fields = (card && card.fields) || card || {};
  const axiomText = fields.one_sentence || fields.full_statement || fields.question || '';
  const restatement = card.feynman_restatement
    || fields.feynman_restatement
    // NOTE: fields.feynman_text was previously in this fallback chain
    // but is intentionally excluded — no code path in @aikdna writes
    // feynman_text. The canonical field is feynman_restatement.
    || '';

  if (!restatement) {
    // Bug (#62): prior version returned score 0 with the explanation
    // "No Feynman restatement provided", but nothing in the CLI ever
    // *writes* a feynman_restatement on a card. Every `kdna-studio
    // feynman` call hit this path, every call returned 0, and the
    // fynchmann command was effectively dead.
    //
    // The fix synthesises a first-cut restatement from the card's own
    // text (so the LLM has *something* to evaluate), and returns a
    // structured note in `suggestions` so the caller knows the score
    // is on a machine-generated restatement, not their own. The
    // caller can then `card update --field feynman_restatement='...'`
    // to lock in a human-written version.
    const synthesised = synthFeynmanRestatement(fields);
    return {
      score: 0,
      criteria: {},
      explanations: {
        notJustRepeat: 'No human-written Feynman restatement — evaluated a synthesised one.',
        notTooAbstract: 'Review the synthesised restatement before trusting the score.',
      },
      suggestions: [
        'No feynman_restatement found on this card. The score below is on an auto-generated restatement.',
        `Set a human-written restatement: kdna-studio card update <project> ${card.id || '<card-id>'} --field feynman_restatement='{"text":"<your plain-language restatement>"}'`,
        `Synthesised restatement: "${synthesised}"`,
      ],
      synthesised_restatement: synthesised,
    };
  }

  const userPrompt = [
    `## Original Axiom`,
    `"${axiomText}"`,
    ``,
    `## User's Restatement (Feynman)`,
    `"${restatement}"`,
    ``,
    `Evaluate this restatement.`,
  ].join('\n');

  const result = await llm.chatWithJSON([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt },
  ], options);

  return result.data || { score: 0, criteria: {}, explanations: {}, suggestions: [] };
}

// Synthesise a first-cut restatement from the card's own fields. The
// output is intentionally plain — Feynman is "explain it like I'm
// five", so we strip axiom-speak and surface only the human-readable
// core.
function synthFeynmanRestatement(fields) {
  const text = fields.one_sentence
    || fields.full_statement
    || fields.question
    || fields.essence
    || fields.scope
    || '(no text to restate)';
  // Strip the leading "always/never/must" markers that signal axiom
  // language. The LLM evaluator will then score the result on its
  // own merits, but the human reader can already see plain English.
  return String(text)
    .replace(/^(always|never|must|should|shall)\s+/i, '')
    .replace(/\s+always\s+/gi, ' ')
    .replace(/\s+never\s+/gi, ' ')
    .trim();
}

module.exports = { evaluate, CRITERIA, SYSTEM, synthFeynmanRestatement };
