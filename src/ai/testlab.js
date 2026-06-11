// TestLab — A/B comparison testing with LLM
const llm = require('../llm');

const COMPARE_SYSTEM = `You are a controlled experiment evaluator. You will see the same user input twice — once with a knowledge domain loaded, and once without. Your task is to produce a structured comparison.

IMPORTANT: You must respond with raw JSON only, no markdown wrapping, no explanatory text.

The JSON format:
{
  "without_kdna": {
    "response": "how you would respond WITHOUT the domain knowledge",
    "classification": "how you categorized the task",
    "diagnosis": "your analysis of the situation",
    "actions": "what actions you would take"
  },
  "with_kdna": {
    "response": "how you respond WITH the domain knowledge applied",
    "classification": "domain-specific classification from the loaded domain",
    "diagnosis": "analysis informed by domain axioms and ontology",
    "actions": "actions influenced by domain judgment"
  },
  "delta": {
    "classification_changed": true/false,
    "diagnosis_changed": true/false,
    "actions_changed": true/false,
    "terminology_changed": true/false,
    "overall_impact": "none" | "minor" | "moderate" | "significant"
  }
}`;

async function compare(config, domainName, input, domainPrompt, options = {}) {
  // Run WITHOUT KDNA
  const withoutResult = await llm.chat([
    { role: 'system', content: COMPARE_SYSTEM },
    { role: 'user', content: `Respond to the following WITHOUT any special domain knowledge:\n\n${input}\n\nRespond with the structured JSON comparison format. For the "without_kdna" section, fill in your normal response. For the "with_kdna" section, fill in what you think would change (we will verify this in a separate pass).` },
  ], { ...options, responseFormat: { type: 'json_object' } });

  let withoutData;
  try { withoutData = JSON.parse(withoutResult.content); } catch { withoutData = { without_kdna: { response: withoutResult.content } }; }

  // Run WITH KDNA
  const withResult = await llm.chat([
    { role: 'system', content: `${domainPrompt}\n\n${COMPARE_SYSTEM}` },
    { role: 'user', content: `Respond to the following WITH the domain knowledge loaded:\n\n${input}\n\nRespond with the structured JSON comparison format. Fill in the "with_kdna" section and the "delta" section based on what actually changed.` },
  ], { ...options, responseFormat: { type: 'json_object' } });

  let withData;
  try { withData = JSON.parse(withResult.content); } catch { withData = { with_kdna: { response: withResult.content } }; }

  return {
    input,
    domain: domainName,
    without_kdna: withoutData.without_kdna || { response: withoutResult.content },
    with_kdna: withData.with_kdna || { response: withResult.content },
    delta: withData.delta || { overall_impact: 'unknown' },
  };
}

async function testPreset(config, domainName, input, domainPrompt, options = {}) {
  const presets = {
    baseline: `Test the core judgment: ${input}`,
    edge_case: `Test a boundary case where domain judgment may or may not apply: ${input}`,
    contradiction: `Test for potential contradiction: present a scenario that challenges the domain's axioms: ${input}`,
  };

  const results = {};
  for (const [name, prompt] of Object.entries(presets)) {
    results[name] = await compare(config, domainName, prompt, domainPrompt, options);
  }
  return results;
}

module.exports = { compare, testPreset, COMPARE_SYSTEM };
