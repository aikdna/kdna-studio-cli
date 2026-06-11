// Sensitive Content Filter — blocks 6 domains in English and Chinese
// Matches behavior of Studio App's SensitiveInferenceFilter
const SENSITIVE_PATTERNS = {
  identity: {
    en: /\b(passport\s*(no|number|#)|id\s*(card|number|#)|social\s*security|ssn|driver'?s?\s*license|national\s*id|身份证|护照号)\b/i,
    zh: /(身份证号|护照号码|社保号|驾驶证号|军官证)/
  },
  health: {
    en: /\b(medical\s*record|patient\s*(id|number)|diagnosis\s*(code|report)|HIV|AIDS|cancer\s*diagnosis|病历|诊断)\b/i,
    zh: /(病历|诊断报告|体检报告|HIV|艾滋病|癌症诊断)/
  },
  political: {
    en: /\b(political\s*(party|affiliation|view)|voting\s*record|party\s*membership|political|政治)\b/i,
    zh: /(政治面貌|党派|政治立场|政见)/
  },
  religious: {
    en: /\b(religious\s*(belief|affiliation|view)|religion|faith\s*(group|community)|宗教)\b/i,
    zh: /(宗教信仰|宗教派别|教派)/
  },
  financial: {
    en: /\b(bank\s*account|credit\s*card\s*number|financial\s*(record|history)|income\s*(level|bracket)|salary|银行|金融)\b/i,
    zh: /(银行卡号|信用卡号|银行账户|收入水平|财务状况|工资)/
  },
  intimate: {
    en: /\b(sexual\s*(orientation|preference|identity)|gender\s*identity|sex\s*(life|history)|marital\s*status|性|性别|婚姻)\b/i,
    zh: /(性取向|性别认同|性生活|婚姻状况|性偏好)/
  },
};

function check(text, options = {}) {
  if (!text || typeof text !== 'string') return { safe: true, flagged: [], matches: {} };

  const flagged = [];
  const matches = {};

  for (const [domain, patterns] of Object.entries(SENSITIVE_PATTERNS)) {
    const activePatterns = [];
    if (options.lang !== 'zh' && patterns.en) activePatterns.push(patterns.en);
    if (options.lang !== 'en' && patterns.zh) activePatterns.push(patterns.zh);

    for (const pattern of activePatterns) {
      const match = text.match(pattern);
      if (match) {
        flagged.push(domain);
        matches[domain] = match[0];
        break;
      }
    }
  }

  return { safe: flagged.length === 0, flagged, matches };
}

function checkEvidence(evidenceList, options = {}) {
  const results = [];
  for (const evidence of evidenceList) {
    const content = evidence.raw_text || evidence.content || '';
    const result = check(content, options);
    if (!result.safe) {
      results.push({
        filename: evidence.filename || evidence.name || 'unknown',
        flagged: result.flagged,
        matches: result.matches,
      });
    }
  }
  return results;
}

module.exports = { check, checkEvidence, SENSITIVE_PATTERNS };
