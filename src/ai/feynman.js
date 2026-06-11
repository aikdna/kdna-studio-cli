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
  const axiomText = card.one_sentence || card.full_statement || '';
  const restatement = card.feynman_text || '';

  if (!restatement) return { score: 0, criteria: {}, explanations: { notJustRepeat: 'No Feynman restatement provided.' }, suggestions: ['Write a Feynman restatement before evaluation.'] };

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

module.exports = { evaluate, CRITERIA, SYSTEM };
