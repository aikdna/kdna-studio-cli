// AI Interview — 4-stage guided judgment authoring
const llm = require('../llm');

const STAGES = {
  distillJudgment: {
    label: 'Extract Judgment',
    system: `You are a domain judgment expert. Your task is to help the user distill their raw knowledge into clear, actionable judgment principles (axioms).

For each axiom, ask the user:
1. What is the core judgment? (one sentence)
2. When does this apply? (specific triggers)
3. When does it NOT apply? (boundaries, exceptions)
4. What happens if they get this wrong? (failure risk)

Be conversational but focused. After the user provides their thoughts, synthesize them into a draft axiom with the format:
- one_sentence: "..."
- full_statement: "..."
- applies_when: [...]
- does_not_apply_when: [...]
- failure_risk: "..."

Then ask if they want to refine it or move to the next principle.`,
  },
  clarifyBoundaries: {
    label: 'Clarify Boundaries',
    system: `You are a boundary clarification expert. Review the axioms drafted so far and help the user identify gaps:

1. Where might these axioms conflict with each other?
2. What edge cases are not covered?
3. Are the "does not apply" conditions specific enough, or are they vague?
4. Would a reasonable person disagree with any of these judgments?

Present one gap at a time and ask the user to clarify. Be direct but constructive.`,
  },
  correctMisreadings: {
    label: 'Correct Misreadings',
    system: `You are a misunderstanding detector. For each axiom, imagine how an AI agent might MISINTERPRET it:

1. Literal vs intended meaning
2. Over-application (applying too broadly)
3. Under-application (not applying when it should)
4. Cultural or context-specific assumptions

For each potential misunderstanding, ask the user: "Is this a valid concern? How would you correct it?"

The user's corrections will become misunderstanding cards that guide the agent toward correct interpretation.`,
  },
  replayScenario: {
    label: 'Replay Scenario',
    system: `You are a scenario simulation expert. For the axioms and misunderstandings defined so far, create realistic test scenarios:

1. A clear-cut case where the judgment applies perfectly
2. An ambiguous case that tests the boundaries
3. A case where the judgment should NOT apply (tempting but wrong)

Present each scenario to the user and ask:
- "What would the correct judgment be here?"
- "What makes this tricky?"
- "Does this reveal any gaps in the axioms?"

The user's responses become the basis for eval cases and scenario cards.`,
  },
};

async function runInterview(config, project, stage, context, options = {}) {
  const stageConfig = STAGES[stage];
  if (!stageConfig) throw new Error(`Unknown interview stage: ${stage}. Valid: ${Object.keys(STAGES).join(', ')}`);

  const systemPrompt = stageConfig.system;
  const userPrompt = [
    `## Project: ${project.name || 'Untitled'}`,
    project.description ? `## Description: ${project.description}` : '',
    ``,
    `## Current State`,
    `Cards: ${(project.cards || []).length} (${(project.cards || []).filter(c => c.locked).length} locked)`,
    project.distillation_candidates ? `Candidates: ${project.distillation_candidates.length}` : '',
    ``,
    `## Context`,
    context || '(no additional context)',
    ``,
    `Begin ${stageConfig.label} stage.`,
  ].filter(Boolean).join('\n');

  const result = await llm.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], options);

  return { stage, label: stageConfig.label, content: result.content };
}

async function runInterviewInteractive(config, project, options = {}) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log(`\n=== KDNA Studio — AI Interview ===`);
  console.log(`Project: ${project.name || 'Untitled'}`);
  console.log(`4 stages: distill → clarify → correct → replay\n`);

  const conversation = [];
  let results = [];

  for (const [stageId, stageConfig] of Object.entries(STAGES)) {
    console.log(`\n--- ${stageConfig.label} ---`);

    const contextParts = [`Project: ${project.name || 'Untitled'}`];
    if (project.description) contextParts.push(`Description: ${project.description}`);
    const cardsSummary = (project.cards || []).map(c => `[${c.type}] ${c.one_sentence || c.concept_name || c.wrong_interpretation || ''}`).join('\n');
    if (cardsSummary) contextParts.push(`Existing cards:\n${cardsSummary}`);

    const initialResponse = await llm.chat([
      { role: 'system', content: stageConfig.system },
      { role: 'user', content: `Start the ${stageConfig.label} stage.\n\nContext:\n${contextParts.join('\n')}` },
    ], options);
    console.log(`\nAI: ${initialResponse.content}\n`);

    let keepGoing = true;
    while (keepGoing) {
      const answer = await ask('You (type "next" to proceed, "done" to finish this stage): ');
      if (answer.toLowerCase() === 'next' || answer.toLowerCase() === 'done') {
        keepGoing = false;
        if (answer.toLowerCase() === 'done') break;
        continue;
      }
      if (!answer.trim()) continue;

      conversation.push({ stage: stageId, role: 'user', content: answer });
      const response = await llm.chat([
        { role: 'system', content: stageConfig.system },
        ...conversation.filter(m => m.stage === stageId).map(m => ({ role: m.role, content: m.content })),
      ], options);
      conversation.push({ stage: stageId, role: 'assistant', content: response.content });
      console.log(`\nAI: ${response.content}\n`);
    }

    results.push({ stage: stageId, label: stageConfig.label, conversation: conversation.filter(m => m.stage === stageId) });
  }

  rl.close();
  return results;
}

module.exports = { STAGES, runInterview, runInterviewInteractive };
