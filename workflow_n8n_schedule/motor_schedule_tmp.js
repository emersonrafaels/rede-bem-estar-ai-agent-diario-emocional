const input = $input.first().json || {};
const http = this.helpers.httpRequest.bind(this.helpers);

const CFG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://mbuljmpamdocnxppueww.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  MAIN_WORKFLOW_WEBHOOK_URL_PROD: process.env.MAIN_WORKFLOW_WEBHOOK_URL_PROD || 'https://n8n.alopsi.com.br/webhook/UfmzO0nzsqKU0hZx',
  MAIN_WORKFLOW_WEBHOOK_URL_TEST: process.env.MAIN_WORKFLOW_WEBHOOK_URL_TEST || 'https://n8n.alopsi.com.br/webhook-test/UfmzO0nzsqKU0hZx',
  MAIN_WORKFLOW_WEBHOOK_ENV: process.env.MAIN_WORKFLOW_WEBHOOK_ENV || 'prod',
  MAIN_WORKFLOW_WEBHOOK_TIMEOUT_MS: Number(process.env.MAIN_WORKFLOW_WEBHOOK_TIMEOUT_MS || 10000),
  REMINDER_INTERNAL_SECRET: process.env.REMINDER_INTERNAL_SECRET || '',
  REMINDER_DEFAULT_TIMEZONE: process.env.REMINDER_DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  REMINDER_DEFAULT_HOUR: process.env.REMINDER_DEFAULT_HOUR || '20:00',
  REMINDER_WINDOW_MINUTES: Number(process.env.REMINDER_WINDOW_MINUTES || 14),
  REMINDER_QUERY_LIMIT: Number(process.env.REMINDER_QUERY_LIMIT || 1000)
};

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function httpJson(url, options) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body;

  const requestOptions = {
    method,
    url,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    timeout: options.timeout || CFG.MAIN_WORKFLOW_WEBHOOK_TIMEOUT_MS,
    returnFullResponse: false,
    ignoreHttpStatusErrors: false
  };

  if (body !== undefined) {
    requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  return await http(requestOptions);
}

async function supabase(path, options) {
  const baseUrl = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const url = baseUrl + '/rest/v1/' + path;

  return await httpJson(url, {
    ...(options || {}),
    headers: {
      apikey: CFG.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + CFG.SUPABASE_SERVICE_ROLE_KEY,
      Prefer: options?.prefer || 'return=representation',
      ...(options?.headers || {})
    }
  });
}

async function dispatchReminderToMainWorkflow(phone, messageText, dispatchContext) {
  const env = String(CFG.MAIN_WORKFLOW_WEBHOOK_ENV || 'prod').trim().toLowerCase();
  const url = env === 'test'
    ? CFG.MAIN_WORKFLOW_WEBHOOK_URL_TEST
    : CFG.MAIN_WORKFLOW_WEBHOOK_URL_PROD;

  return await httpJson(url, {
    method: 'POST',
    headers: {
      'x-internal-secret': CFG.REMINDER_INTERNAL_SECRET
    },
    body: {
      internal_reminder: true,
      auth_secret: CFG.REMINDER_INTERNAL_SECRET,
      phone,
      message_text: messageText,
      source: 'schedule',
      dispatch_context: dispatchContext
    },
    timeout: CFG.MAIN_WORKFLOW_WEBHOOK_TIMEOUT_MS
  });
}

async function logDispatch(row) {
  try {
    await supabase('whatsapp_reminder_dispatch_logs', { method: 'POST', body: row });
  } catch (_) {}
}

async function updateLastReminded(phone, isoTimestamp) {
  await supabase('whatsapp_reminder_preferences?phone=eq.' + encodeURIComponent(phone), {
    method: 'PATCH',
    body: {
      last_reminded_at: isoTimestamp,
      updated_at: isoTimestamp
    }
  });
}

function buildReminderMessage(localHourLabel) {
  return [
    '💜 Oi! Passando para lembrar do seu Diário Emocional.',
    '',
    'Leva menos de 2 minutos e pode te ajudar a perceber padrões com mais clareza.',
    '',
    'Quando quiser, envie *diário* para registrar.',
    '',
    '⏰ Lembrete configurado para: ' + localHourLabel
  ].join('\n');
}

function getLocalPartsForTimestamp(isoTimestamp, timezone) {
  try {
    const ts = isoTimestamp ? new Date(isoTimestamp) : new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    });

    const parts = Object.fromEntries(formatter.formatToParts(ts).map(p => [p.type, p.value]));
    return {
      localDate: parts.year + '-' + parts.month + '-' + parts.day,
      hour: Number(parts.hour === '24' ? 0 : parts.hour),
      minute: Number(parts.minute),
      weekday: parts.weekday?.toLowerCase() || null
    };
  } catch (_) {
    return null;
  }
}

function getLocalDateForTimestamp(isoTimestamp, timezone) {
  if (!isoTimestamp) return null;
  const parts = getLocalPartsForTimestamp(isoTimestamp, timezone);
  return parts ? parts.localDate : null;
}

function parseTargetTime(hourStr) {
  const [h, m] = String(hourStr || '20:00').split(':').map(Number);
  return {
    hours: isNaN(h) ? 20 : h,
    minutes: isNaN(m) ? 0 : m,
    label: String(isNaN(h) ? 20 : h).padStart(2, '0') + ':' + String(isNaN(m) ? 0 : m).padStart(2, '0')
  };
}

function circularMinuteDiff(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 1440 - diff);
}

function parseWeekdays(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(d => String(d).toLowerCase());
  if (typeof value === 'string') {
    try {
      const arr = JSON.parse(value);
      if (Array.isArray(arr)) return arr.map(d => String(d).toLowerCase());
    } catch (_) {}
    return value.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  }
  return null;
}

if (!CFG.SUPABASE_URL || !CFG.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para o workflow agendado.');
}

if (!CFG.REMINDER_INTERNAL_SECRET) {
  throw new Error('REMINDER_INTERNAL_SECRET é obrigatório para o handoff seguro entre workflows.');
}

if (!CFG.MAIN_WORKFLOW_WEBHOOK_URL_PROD && !CFG.MAIN_WORKFLOW_WEBHOOK_URL_TEST) {
  throw new Error('MAIN_WORKFLOW_WEBHOOK_URL_PROD ou _TEST é obrigatório para o workflow agendado.');
}

const summary = {
  scanned: 0,
  due: 0,
  sent: 0,
  skipped_weekday: 0,
  skipped_window: 0,
  skipped_duplicate: 0,
  skipped_invalid: 0,
  failed: 0,
  env: String(CFG.MAIN_WORKFLOW_WEBHOOK_ENV || 'prod')
};

const selectPath = 'whatsapp_reminder_preferences?is_enabled=eq.true&select=phone,user_id,tenant_id,timezone,reminder_hour_local,reminder_weekdays,last_reminded_at,updated_at&limit=' + Math.max(1, Number(CFG.REMINDER_QUERY_LIMIT || 1000));
const rows = await supabase(selectPath, { method: 'GET' });
const preferences = Array.isArray(rows) ? rows : [];
summary.scanned = preferences.length;

for (const pref of preferences) {
  const phone = normalizePhone(pref.phone);
  if (!phone) {
    summary.skipped_invalid += 1;
    continue;
  }

  const timezone = String(pref.timezone || CFG.REMINDER_DEFAULT_TIMEZONE || 'America/Sao_Paulo');
  const localParts = getLocalPartsForTimestamp(new Date().toISOString(), timezone);

  if (!localParts) {
    summary.skipped_invalid += 1;
    continue;
  }

  const weekdays = parseWeekdays(pref.reminder_weekdays);
  if (weekdays && weekdays.length > 0 && localParts.weekday && !weekdays.includes(localParts.weekday)) {
    summary.skipped_weekday += 1;
    continue;
  }

  const target = parseTargetTime(pref.reminder_hour_local || CFG.REMINDER_DEFAULT_HOUR);
  const nowMinutes = localParts.hour * 60 + localParts.minute;
  const targetMinutes = target.hours * 60 + target.minutes;
  const allowedWindow = Math.max(0, Number(CFG.REMINDER_WINDOW_MINUTES || 14));

  if (circularMinuteDiff(nowMinutes, targetMinutes) > allowedWindow) {
    summary.skipped_window += 1;
    continue;
  }

  const lastLocalDate = getLocalDateForTimestamp(pref.last_reminded_at, timezone);
  if (lastLocalDate && lastLocalDate === localParts.localDate) {
    summary.skipped_duplicate += 1;
    continue;
  }

  summary.due += 1;

  const nowIso = new Date().toISOString();
  const dispatchContext = {
    timezone,
    local_date: localParts.localDate,
    target_hour: target.label,
    preference_updated_at: pref.updated_at || null
  };

  try {
    const result = await dispatchReminderToMainWorkflow(
      phone,
      buildReminderMessage(target.label),
      dispatchContext
    );

    const mainOk = result?.ok === true || result?.internal_reminder_sent === true;

    if (mainOk) {
      await updateLastReminded(phone, nowIso);
      summary.sent += 1;

      await logDispatch({
        phone,
        user_id: pref.user_id || null,
        tenant_id: pref.tenant_id || null,
        status: 'sent',
        timezone,
        local_date: localParts.localDate,
        local_hour_minute: String(localParts.hour).padStart(2, '0') + ':' + String(localParts.minute).padStart(2, '0'),
        target_hour_minute: target.label,
        metadata: {
          weekday: localParts.weekday,
          env: summary.env,
          main_workflow_ok: true
        },
        attempted_at: nowIso
      });
    } else {
      summary.failed += 1;

      await logDispatch({
        phone,
        user_id: pref.user_id || null,
        tenant_id: pref.tenant_id || null,
        status: 'failed',
        error_code: 'MAIN_WORKFLOW_RETURNED_NOT_OK',
        timezone,
        local_date: localParts.localDate,
        target_hour_minute: target.label,
        metadata: { env: summary.env },
        attempted_at: nowIso
      });
    }
  } catch (err) {
    summary.failed += 1;

    await logDispatch({
      phone,
      user_id: pref.user_id || null,
      tenant_id: pref.tenant_id || null,
      status: 'failed',
      error_code: 'DISPATCH_ERROR',
      error_message: String(err?.message || '').slice(0, 200),
      timezone,
      local_date: localParts.localDate,
      target_hour_minute: target.label,
      metadata: { env: summary.env },
      attempted_at: nowIso
    });
  }
}

return [{
  json: {
    success: true,
    summary,
    executed_at: new Date().toISOString()
  }
}];
