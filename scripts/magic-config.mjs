const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f\u2028\u2029]/;
const PROXY_FIELDS = ['server', 'port', 'username', 'password'];
const MAX_PROXY_CHARACTERS = 4096;

function validateProxy(proxy) {
  if (!proxy || PROXY_FIELDS.some((field) => (
    typeof proxy[field] !== 'string'
    || !proxy[field].trim()
    || CONTROL_CHARACTER_PATTERN.test(proxy[field])
  ))) {
    throw new Error('代理参数不能为空或包含换行、控制字符。');
  }
  if (PROXY_FIELDS.reduce((length, field) => length + proxy[field].length, 3) > MAX_PROXY_CHARACTERS) {
    throw new Error('代理参数总长度不能超过 4096 个字符。');
  }
  if (/\s/.test(proxy.server)) throw new Error('代理服务器地址不能包含空白字符。');
  if (!/^\d+$/.test(proxy.port) || Number(proxy.port) < 1 || Number(proxy.port) > 65535) {
    throw new Error('代理端口必须是 1 到 65535 之间的整数。');
  }
  return proxy;
}

export function parseProxyValue(value) {
  const text = String(value ?? '');
  if (text.length > MAX_PROXY_CHARACTERS) throw new Error('代理参数总长度不能超过 4096 个字符。');
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    throw new Error('代理参数不能包含换行或控制字符。');
  }
  const match = text.trim().match(/^(\[[^\]]+\]|[^:]+):([^:]+):([^:]+):(.+)$/);
  if (!match) {
    throw new Error('代理参数格式错误，请使用：服务器:端口:用户名:密码。');
  }
  const [, rawServer, rawPort, rawUsername, rawPassword] = match;
  return validateProxy({
    server: rawServer.trim().replace(/^\[([^\]]+)\]$/, '$1'),
    port: rawPort.trim(),
    username: rawUsername.trim(),
    password: rawPassword.trim(),
  });
}

export function renderMagicConfig(template, proxy) {
  validateProxy(proxy);
  let config = String(template);
  for (const field of PROXY_FIELDS) {
    const pattern = new RegExp(`^([ \\t]*)${field}[ \\t]*:[^\\r\\n]*$`, 'gm');
    let count = 0;
    config = config.replace(pattern, (_line, indent) => {
      count += 1;
      return `${indent}${field}: '${proxy[field].replaceAll("'", "''")}'`;
    });
    if (count !== 1) {
      throw new Error(`Magic 配置模板必须包含且仅包含一个 ${field} 字段。`);
    }
  }
  return config;
}

export function normalizeContractId(value) {
  const contractId = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(contractId)) {
    throw new Error('合约 ID 格式无效，只能包含字母、数字、下划线和连字符。');
  }
  return contractId;
}

export function contractIdTextPattern(value) {
  const contractId = normalizeContractId(value);
  return new RegExp(`^(?:(?:合约\\s*)?[Ii][Dd]\\s*[:：]\\s*)?${contractId}$`);
}
