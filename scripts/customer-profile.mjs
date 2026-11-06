const EMAIL_PATTERN = /[A-Z0-9._%+-]+\\?@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const keyAliases = new Map([
  ['公司名称', '公司名称'],
  ['公司名', '公司名称'],
  ['公司', '公司名称'],
  ['企业名称', '公司名称'],
  ['客户名称', '公司名称'],
  ['客户', '公司名称'],
  ['应用场景', '应用场景'],
  ['使用场景', '应用场景'],
  ['业务场景', '应用场景'],
  ['加速场景', '应用场景'],
  ['场景', '应用场景'],
  ['加速类型', '加速类型'],
  ['网络加速', '加速类型'],
  ['套餐', '加速类型'],
  ['邮箱', '邮箱'],
  ['邮箱地址', '邮箱'],
  ['邮件', '邮箱'],
  ['email', '邮箱'],
  ['e-mail', '邮箱'],
  ['部署方式', '部署方式'],
  ['部署', '部署方式'],
  ['交付方式', '部署方式'],
  ['交付', '部署方式'],
]);

export function normalizeLine(line) {
  return String(line ?? '')
    .trim()
    .replace(/：/g, ':')
    .replace(/\s+/g, ' ');
}

function normalizeKey(key) {
  return String(key ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

function canonicalKey(key) {
  return keyAliases.get(normalizeKey(key)) ?? String(key ?? '').trim();
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().replace(/\\+@/g, '@').replace(/\s+/g, '');
}

export function parseKeyValues(text) {
  const fields = {};
  const freeLines = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    const emailMatch = line.match(EMAIL_PATTERN);
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      fields[key] = value;
      fields[canonicalKey(key)] = value;
      continue;
    }

    if (emailMatch && !fields['邮箱']) {
      fields['邮箱'] = normalizeEmail(emailMatch[0]);
      const withoutEmail = line.replace(emailMatch[0], '').replace(/邮箱|邮件|email|e-mail/ig, '').trim();
      if (withoutEmail) freeLines.push(withoutEmail);
      continue;
    }

    freeLines.push(line);
  }

  return { fields, freeLines };
}

function isDeploymentLine(line) {
  return /(?:软件|硬件|CPE|设备|交付|部署|拿走|寄送|地址|群里)/i.test(line);
}

function isLikelyCompanyName(line) {
  if (EMAIL_PATTERN.test(line)) return false;
  if (/\d+\s*M/i.test(line)) return false;
  if (isDeploymentLine(line)) return false;

  return /(?:有限责任公司|股份有限公司|有限公司|公司|工作室|个体工商户|商行|经营部|中心|厂)/.test(line);
}

function compactParts(parts) {
  return parts.map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
}

export function parseCustomerProfile(text) {
  const { fields, freeLines } = parseKeyValues(text);
  let companyName = String(fields['公司名称'] ?? '').trim();
  let email = normalizeEmail(fields['邮箱'] ?? '');
  const sceneLines = [];
  const deploymentLines = [];

  for (const line of freeLines) {
    const emailMatch = line.match(EMAIL_PATTERN);
    if (!email && emailMatch) {
      email = normalizeEmail(emailMatch[0]);
      continue;
    }

    if (!companyName && isLikelyCompanyName(line)) {
      companyName = line;
      continue;
    }

    if (isDeploymentLine(line)) {
      deploymentLines.push(line);
      continue;
    }

    sceneLines.push(line);
  }

  const applicationScene = compactParts([fields['应用场景'], ...sceneLines]);
  const deploymentMode = compactParts([fields['部署方式'], ...deploymentLines]);
  const acceleratorText = compactParts([fields['加速类型'], applicationScene]);

  return {
    fields,
    freeLines,
    companyName,
    applicationScene,
    acceleratorText,
    email,
    deploymentMode,
  };
}
