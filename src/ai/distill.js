// AI Distillation — extract candidate judgment patterns from evidence
const llm = require('../llm');

const SYSTEM = `You are a domain judgment extraction engine. Your task is to analyze source materials and extract candidate cognitive patterns that can become axioms, ontologies, misunderstandings, or self-checks in a knowledge domain.

For each candidate you find, provide:
- candidate_id: unique identifier (kebab-case, e.g. "axiom-early-feedback")
- type: one of [axiom, ontology, misunderstanding, self_check, framework, stance]
- one_sentence: a single clear sentence capturing the judgment principle
- full_statement: 2-4 sentence explanation with concrete examples
- confidence: one of [high, medium, low]
- evidence_ids: array of source file names that support this candidate
- scope_fit: true (unless the candidate clearly belongs to a different domain)

IMPORTANT:
- Extract ONLY patterns that represent judgment, standards, or cognitive frameworks — not facts or summaries
- Each candidate must be testable: you should be able to construct an eval case that verifies the agent applies it
- Prefer quality over quantity: 5-15 strong candidates is better than 30 weak ones
- Skip anything that is purely factual, biographical, or outside the domain's scope

Return ONLY valid JSON: {"candidates": [...]}`;

async function distill(config, evidence, target, options = {}) {
  const evidenceText = formatEvidence(evidence);
  const targetText = formatTarget(target);

  const userPrompt = [
    `## Distillation Target`,
    targetText,
    ``,
    `## Source Materials`,
    evidenceText,
    ``,
    `Extract candidate judgment patterns from these materials that are relevant to the target domain.`,
  ].join('\n');

  const result = await llm.chatWithJSON([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt },
  ], options);

  const candidates = (result.data && result.data.candidates) || [];
  return candidates.map(c => ({
    id: c.candidate_id || `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    one_sentence: c.one_sentence || '',
    full_statement: c.full_statement || '',
    suggested_card_type: c.type || 'axiom',
    supporting_evidence_ids: (c.evidence_ids || []).map(String),
    confidence: c.confidence || 'medium',
    candidate_status: 'proposed',
    scope_fit: c.scope_fit !== false,
  }));
}

function formatEvidence(evidence) {
  if (!evidence || evidence.length === 0) return '(no evidence loaded)';
  return evidence.map((e, i) => {
    const label = e.filename || e.name || `Source ${i + 1}`;
    const content = (e.content || '').slice(0, 8000);
    return `### ${label}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');
}

function formatTarget(target) {
  if (!target) return '(no target declared)';
  const parts = [];
  if (target.domain_name) parts.push(`Domain: ${target.domain_name}`);
  if (target.category) parts.push(`Category: ${target.category}`);
  if (target.owner_scope) parts.push(`Scope: ${target.owner_scope}`);
  if (target.granularity) parts.push(`Granularity: ${target.granularity}`);
  if (target.task_scope) parts.push(`Task Scope: ${target.task_scope}`);
  if (target.include_areas) parts.push(`Include: ${target.include_areas.join(', ')}`);
  if (target.exclude_areas) parts.push(`Exclude: ${target.exclude_areas.join(', ')}`);
  return parts.join('\n');
}

module.exports = { distill, SYSTEM };
