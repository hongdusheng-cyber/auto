// Preset groups are expanded by the control panel. These aliases only reconcile
// one application name with the administrator's backend/display names.
const KNOWN_RULES = [
  { backend: '抖音规则包', display: 'office365', aliases: ['office365', '抖音规则包'] },
  { backend: 'TikTok跨境电商', display: 'TikTok跨境电商', aliases: ['TikTok跨境电商', 'TikTok', 'TK'] },
  { backend: 'Google', display: 'GL', aliases: ['Google', 'GL', '谷歌'] },
  { backend: 'Google 登录', display: 'GLSIGNIN', aliases: ['Google 登录', 'Google登录', 'GLSIGNIN', '谷歌登录'] },
  { backend: 'whatsapp', display: 'WA', aliases: ['whatsapp', 'WA'] },
  { backend: 'Youtube', display: 'Y', aliases: ['Youtube', 'Y', 'YouTube'] },
  { backend: 'instagram', display: 'instagram', aliases: ['instagram', 'Instagram'] },
  { backend: 'Facebook', display: 'Facebook', aliases: ['Facebook'] },
  { backend: 'Linkedin', display: 'Link', aliases: ['Linkedin', 'LinkedIn', 'Link'] },
  { backend: 'Twitter(X.com)', display: 'Twitter(X.com)', aliases: ['Twitter(X.com)', 'Twitter', 'X.com'] },
  { backend: 'Telegram', display: 'tG', aliases: ['Telegram', 'tG'] },
  { backend: 'Pinterest', display: 'Pin', aliases: ['Pinterest', 'Pin'] },
  { backend: 'Discord', display: 'DC', aliases: ['Discord', 'DC'] },
];

export function normalizeHiddenRuleName(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
}

export function parseHiddenRuleLabel(value) {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim();
  // Split the final balanced parenthesis group, preserving nested parentheses
  // in names such as "Anthropic(Claude) (Anthropic(Claude))".
  let depth = 0;
  if (/[)）]$/.test(label)) {
    for (let index = label.length - 1; index >= 0; index -= 1) {
      if (/[)）]/.test(label[index])) depth += 1;
      if (/[(（]/.test(label[index])) depth -= 1;
      if (depth === 0) {
        if (index > 0 && /\s/.test(label[index - 1])) {
          return { label, backend: label.slice(0, index).trim(), display: label.slice(index + 1, -1).trim() };
        }
        break;
      }
    }
  }
  return { label, backend: label, display: label };
}

function knownRule(value) {
  const normalized = normalizeHiddenRuleName(value);
  return KNOWN_RULES.find((rule) => rule.aliases.some((alias) => normalizeHiddenRuleName(alias) === normalized));
}

export function findHiddenRuleMatches(value, labels, { aliases = true } = {}) {
  const normalized = normalizeHiddenRuleName(value);
  const candidates = labels.map((label, index) => ({ ...parseHiddenRuleLabel(label), index }));
  const direct = candidates.filter((candidate) => [candidate.label, candidate.backend, candidate.display]
    .some((part) => normalizeHiddenRuleName(part) === normalized));
  if (direct.length || !aliases) return direct;

  const known = knownRule(value);
  if (!known) return [];
  return candidates.filter((candidate) => (
    normalizeHiddenRuleName(candidate.backend) === normalizeHiddenRuleName(known.backend)
    && normalizeHiddenRuleName(candidate.display) === normalizeHiddenRuleName(known.display)
  ));
}
