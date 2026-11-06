const PREFIX = 'ACCOUNT_RESULT ';

// Child streams may split anywhere, including inside a password. Only process
// complete lines and keep credentials out of the general log stream.
export function createAccountOutputParser(onResult, onLog) {
  let pending = '';
  function line(value) {
    if (!value.startsWith(PREFIX)) {
      onLog(value);
      return;
    }
    try {
      const result = JSON.parse(value.slice(PREFIX.length));
      if (result && ['success', 'error'].includes(result.status)) onResult(result);
    } catch {
      onLog('[错误] 添加账号结果格式无效，无法确认结果。\n');
    }
  }
  return {
    push(chunk) {
      pending += String(chunk);
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 32768) {
        if (!pending.startsWith(PREFIX)) onLog(pending);
        pending = '';
      }
    },
    finish() {
      if (pending && !pending.startsWith(PREFIX)) onLog(pending);
      pending = '';
    },
  };
}

export function normalizeAccountResult(result, options) {
  const base = {
    companyName: options.companyName,
    fullName: options.fullName,
    account: options.email,
    phone: /^1[3-9]\d{9}$/.test(result.phone) ? result.phone : '',
  };
  if (result.status === 'success') {
    if (result.companyName !== base.companyName || result.fullName !== base.fullName
      || result.account !== base.account || !base.phone
      || typeof result.password !== 'string' || !/^[A-Za-z0-9]{10}$/.test(result.password)) {
      return { ...base, status: 'error', message: '添加账号结果与本次参数不一致，无法确认；请检查后台，勿重复提交。' };
    }
    return { ...base, status: 'success', password: result.password, message: String(result.message || '账号添加成功').slice(0, 2000) };
  }
  return { ...base, status: 'error', message: String(result.message || '添加账号失败，请检查后台。').slice(0, 2000) };
}
