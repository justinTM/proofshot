const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = /(?:form.*value|clipboard|password|passwd|secret|token|authorization|cookie)/i;
const SENSITIVE_SET_TARGET = /(?:clipboard|cookie|credentials?|headers?|auth|token|password|secret)/i;

export function redactBrowserValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEYS.test(key) && value !== undefined && value !== null) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactBrowserValue(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const containsFormState = record.kind === 'clipboard' || record.kind === 'form'
      || record.type === 'input' || 'focus' in record || 'field' in record || 'tagName' in record;
    return Object.fromEntries(
      Object.entries(record).map(([childKey, child]) => [
        childKey,
        childKey === 'value' && containsFormState ? REDACTED : redactBrowserValue(child, childKey),
      ]),
    );
  }
  return value;
}

function redactUrlArgument(value: string): { value: string; secretValues: string[] } {
  try {
    const url = new URL(value);
    const secretValues: string[] = [];
    if (url.username) {
      secretValues.push(url.username);
      url.username = REDACTED;
    }
    if (url.password) {
      secretValues.push(url.password);
      url.password = REDACTED;
    }
    for (const [key, item] of [...url.searchParams.entries()]) {
      if (SENSITIVE_KEYS.test(key)) {
        secretValues.push(item);
        url.searchParams.set(key, REDACTED);
      }
    }
    return { value: url.toString(), secretValues };
  } catch {
    return { value, secretValues: [] };
  }
}

export function redactBrowserUrl(value: string): { url: string; redacted: boolean } {
  const result = redactUrlArgument(value);
  return { url: result.value, redacted: result.secretValues.length > 0 };
}

export interface RedactedBrowserAction {
  action: string;
  args: string[];
  secretValues: string[];
  redactOutput: boolean;
}

export function redactBrowserAction(args: readonly string[]): RedactedBrowserAction {
  const command = args[0]?.toLowerCase() ?? '';
  const redacted = [...args];
  const secretValues: string[] = [];
  let redactOutput = false;
  if (['fill', 'type'].includes(command) && redacted.length > 2) {
    secretValues.push(...redacted.slice(2));
    redacted.splice(2, redacted.length - 2, REDACTED);
  }
  if (command === 'set' && SENSITIVE_SET_TARGET.test(redacted[1] ?? '') && redacted.length > 2) {
    secretValues.push(...redacted.slice(2));
    redacted.splice(2, redacted.length - 2, REDACTED);
  }
  if (command === 'eval' && redacted.length > 1) {
    secretValues.push(...redacted.slice(1));
    redacted.splice(1, redacted.length - 1, REDACTED);
    redactOutput = true;
  }
  if (['open', 'navigate'].includes(command) && redacted[1]) {
    const url = redactUrlArgument(redacted[1]);
    redacted[1] = url.value;
    secretValues.push(...url.secretValues);
  }
  if (redacted.some((part) => /clipboard/i.test(part))) redactOutput = true;
  return { action: redacted.join(' '), args: redacted, secretValues, redactOutput };
}

export function redactBrowserText(text: string, secretValues: readonly string[]): string {
  return [...new Set(secretValues.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join(REDACTED), text);
}

export function redactKnownBrowserSecrets(value: unknown, secretValues: readonly string[]): unknown {
  if (typeof value === 'string') return redactBrowserText(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactKnownBrowserSecrets(item, secretValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactKnownBrowserSecrets(item, secretValues)]),
    );
  }
  return value;
}
