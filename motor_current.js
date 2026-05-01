

const input = $input.first().json;
const CFG = input.cfg || {};
const body = input.body || input;

const n8nHttpRequest = this.helpers.httpRequest.bind(this.helpers);
const HTTP_TIMEOUT_MS = Number(CFG.HTTP_TIMEOUT_MS || 12000);
const HTTP_MAX_RETRIES = Number(CFG.HTTP_MAX_RETRIES || 2);
const HTTP_RETRY_BASE_MS = Number(CFG.HTTP_RETRY_BASE_MS || 400);
const INBOUND_RATE_LIMIT_MAX = Number(CFG.INBOUND_RATE_LIMIT_MAX || 12);
const INBOUND_RATE_LIMIT_WINDOW_SECONDS = Number(CFG.INBOUND_RATE_LIMIT_WINDOW_SECONDS || 30);
const RATE_LIMIT_COOLDOWN_BASE_SECONDS = Number(CFG.RATE_LIMIT_COOLDOWN_BASE_SECONDS || 8);
const RATE_LIMIT_COOLDOWN_MAX_SECONDS = Number(CFG.RATE_LIMIT_COOLDOWN_MAX_SECONDS || 120);
const SESSION_STALE_HOURS = Number(CFG.SESSION_STALE_HOURS || 4);

let inboundDedupDisabled = false;
let inboundRateLimitCooldownDisabled = false;
let stateTransitionExpectedUpdatedAt = null;

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function extractMessageId(data = {}) {
  return (
    data.key?.id ||
    data.id ||
    data.messageId ||
    data.message_id ||
    data.msgId ||
    ''
  );
}

function extractPayload(payload) {
  const data = payload.data || payload;

  const remoteJid =
    data.key?.remoteJid ||
    data.remoteJid ||
    data.from ||
    data.number ||
    data.sender ||
    '';

  const phone = normalizePhone(
    String(remoteJid)
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '')
  );

  const message =
    data.message?.conversation ||
    data.message?.extendedTextMessage?.text ||
    data.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    data.text ||
    data.body ||
    data.messageText ||
    '';

  const messageId = String(extractMessageId(data) || '').trim();

  return {
    phone,
    messageId,
    text: String(message || '').trim(),
    textLower: String(message || '').trim().toLowerCase(),
    raw: payload
  };
}

async function hashCode(code) {
  const normalized = String(code || '').trim();

  if (globalThis?.crypto?.subtle && typeof TextEncoder !== 'undefined') {
    const encoded = new TextEncoder().encode(normalized);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
    const bytes = Array.from(new Uint8Array(digest));

    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return hashCodeFallback(normalized);
}

function hashCodeFallback(input) {
  // Deterministic fallback for environments where Web Crypto is unavailable.
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const p3 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
  const p4 = (Math.imul(h1, h2) >>> 0).toString(16).padStart(8, '0');

  return `${p1}${p2}${p3}${p4}`;
}

function newOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isStartCommand(t) {
  return ['diario', 'diário', 'checkin', 'check-in', 'começar', 'comecar', 'iniciar'].includes(t);
}

function isCancel(t) {
  return ['cancelar', 'sair', 'parar', 'encerrar', 'reiniciar'].includes(t);
}

function isBack(t) {
  return ['voltar', 'anterior', 'volta'].includes(t);
}

function isHelp(t) {
  return ['ajuda', 'help', '?', 'comandos'].includes(t);
}

function isResumo(t) {
  return ['resumo', 'historico', 'histórico', 'semana'].includes(t);
}

function isRegistrarHojeCommand(t) {
  return ['registrar hoje', 'registrar diário hoje', 'registrar diario hoje'].includes(t);
}

function isAjustarHojeCommand(t) {
  return ['ajustar hoje', 'editar hoje', 'ajustar diário hoje', 'ajustar diario hoje'].includes(t);
}

function isUltimoRegistroCommand(t) {
  return ['último registro', 'ultimo registro', 'ver último registro', 'ver ultimo registro'].includes(t);
}

function isInsightsCommand(t) {
  return ['insights', 'meus insights', 'ver insights'].includes(t);
}

function isReminderEnableCommand(t) {
  return ['ativar lembretes', 'ativar aviso', 'ativar notificacao', 'lembretes', 'aviso', 'notificacao'].includes(t);
}

function isReminderDisableCommand(t) {
  return ['desativar lembretes', 'desativar aviso', 'desativar notificacao', 'sem lembretes', 'sem aviso'].includes(t);
}

function parseScaleNumber(text, scaleMin = 1, scaleMax = 5) {
  const n = Number(String(text || '').trim());

  if (!Number.isInteger(n)) return null;
  if (n < Number(scaleMin) || n > Number(scaleMax)) return null;

  return n;
}

function number1to5(t) {
  return parseScaleNumber(t, 1, 5);
}

function isEmail(t) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t).trim());
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatDateBR(dateValue) {
  if (!dateValue) return 'data não informada';

  const [year, month, day] = String(dateValue).slice(0, 10).split('-');

  if (!year || !month || !day) {
    return String(dateValue);
  }

  return `${day}/${month}/${year}`;
}

function parseDateInput(text) {
  const value = String(text || '').trim().toLowerCase();

  if (value === 'hoje') return todayISO();
  if (value === 'ontem') return yesterdayISO();

  const brMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, day, month, year] = brMatch;
    return `${year}-${month}-${day}`;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;

  const weekdayMap = {
    'segunda': 1, 'segunda-feira': 1,
    'terca': 2, 'terca-feira': 2, 'terça': 2, 'terça-feira': 2,
    'quarta': 3, 'quarta-feira': 3,
    'quinta': 4, 'quinta-feira': 4,
    'sexta': 5, 'sexta-feira': 5,
    'sabado': 6, 'sábado': 6,
    'domingo': 0
  };

  const pastSuffixes = ['passada', 'passado', 'da semana passada', 'da semana anterior'];
  let cleanValue = value;
  let forcePreviousWeek = false;

  for (const suffix of pastSuffixes) {
    if (cleanValue.endsWith(' ' + suffix) || cleanValue === suffix) {
      cleanValue = cleanValue.slice(0, cleanValue.length - suffix.length).trim().replace(/-$/, '').trim();
      forcePreviousWeek = true;
      break;
    }
  }

  const targetWeekday = weekdayMap[cleanValue];
  if (targetWeekday !== undefined) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDay = today.getDay();

    let diff = todayDay - targetWeekday;
    if (diff < 0) diff += 7;
    if (forcePreviousWeek && diff < 7) diff += 7;

    const result = new Date(today);
    result.setDate(today.getDate() - diff);
    return result.toISOString().slice(0, 10);
  }

  return null;
}

function isFutureDate(dateISO) {
  return String(dateISO) > todayISO();
}

function parseEmojiSet(emojiSet) {
  if (Array.isArray(emojiSet)) {
    return emojiSet.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof emojiSet === 'string') {
    const raw = emojiSet.trim();

    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch (_) {}

    return raw.split(/[|,]/).map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

const DEFAULT_EMOTION_CATALOG = {
  mood: {
    category: 'basic',
    display_name: 'Humor',
    description: 'Como você está se sentindo hoje?',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😢', '😓', '😐', '😊', '🤩'],
    color_scheme: {
      low: 'hsl(0, 70%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(120, 60%, 50%)'
    }
  },
  anxiety: {
    category: 'basic',
    display_name: 'Ansiedade',
    description: 'Como está sua ansiedade?',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😌', '🙂', '😐', '😟', '😰'],
    color_scheme: {
      low: 'hsl(120, 60%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(0, 70%, 50%)'
    }
  },
  energy: {
    category: 'basic',
    display_name: 'Energia',
    description: 'Qual seu nível de energia?',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😴', '🥱', '😐', '⚡', '🔥'],
    color_scheme: {
      low: 'hsl(210, 50%, 40%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(30, 100%, 50%)'
    }
  },
  stress: {
    category: 'advanced',
    display_name: 'Estresse',
    description: 'Nível de estresse percebido',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['🧘', '😌', '😐', '😥', '😓'],
    color_scheme: {
      low: 'hsl(120, 60%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(0, 70%, 50%)'
    }
  },
  motivation: {
    category: 'advanced',
    display_name: 'Motivação',
    description: 'Quão motivado você se sente?',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😞', '😕', '😐', '🙂', '😊'],
    color_scheme: {
      low: 'hsl(210, 50%, 40%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(280, 70%, 50%)'
    }
  },
  focus: {
    category: 'advanced',
    display_name: 'Foco',
    description: 'Capacidade de concentração',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😶', '🤔', '🎯', '🎯', '🎯'],
    color_scheme: {
      low: 'hsl(0, 70%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(200, 70%, 50%)'
    }
  },
  gratitude: {
    category: 'wellbeing',
    display_name: 'Gratidão',
    description: 'Sentimento de gratidão',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😓', '😕', '😐', '🙂', '😊'],
    color_scheme: {
      low: 'hsl(210, 50%, 40%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(320, 70%, 60%)'
    }
  },
  confidence: {
    category: 'wellbeing',
    display_name: 'Confiança',
    description: 'Autoconfiança',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😰', '😟', '😕', '😐', '🙂'],
    color_scheme: {
      low: 'hsl(0, 70%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(280, 70%, 50%)'
    }
  },
  hope: {
    category: 'wellbeing',
    display_name: 'Esperança',
    description: 'Nível de esperança e otimismo',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😞', '😕', '😐', '🙂', '😊'],
    color_scheme: {
      low: 'hsl(210, 50%, 40%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(200, 70%, 60%)'
    }
  },
  creativity: {
    category: 'professional',
    display_name: 'Criatividade',
    description: 'Nível de criatividade',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😶', '😐', '🙂', '😊', '💡'],
    color_scheme: {
      low: 'hsl(210, 50%, 40%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(280, 70%, 50%)'
    }
  },
  productivity: {
    category: 'professional',
    display_name: 'Produtividade',
    description: 'Quão produtivo você se sentiu?',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😴', '😕', '😐', '🙂', '😊'],
    color_scheme: {
      low: 'hsl(0, 70%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(120, 60%, 50%)'
    }
  },
  satisfaction: {
    category: 'professional',
    display_name: 'Satisfação',
    description: 'Satisfação geral com o dia',
    scale_min: 1,
    scale_max: 5,
    emoji_set: ['😞', '😕', '😐', '🙂', '😊'],
    color_scheme: {
      low: 'hsl(0, 70%, 50%)',
      mid: 'hsl(45, 100%, 50%)',
      high: 'hsl(120, 60%, 50%)'
    }
  }
};

function getEmotionCatalogDefinition(emotionType) {
  const key = String(emotionType || '').trim().toLowerCase();
  return DEFAULT_EMOTION_CATALOG[key] || null;
}

function parseColorScheme(value) {
  if (!value) return null;

  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      low: value.low || null,
      mid: value.mid || null,
      high: value.high || null
    };
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          low: parsed.low || null,
          mid: parsed.mid || null,
          high: parsed.high || null
        };
      }
    } catch (_) {}

    const parts = raw.split(/[|,]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) {
      return {
        low: parts[0],
        mid: parts[1],
        high: parts[2]
      };
    }
  }

  return null;
}

function normalizeEmotionConfigurations(rows = []) {
  return rows
    .map((row, index) => {
      const emotionType = String(row?.emotion_type || '').trim().toLowerCase();
      const catalog = getEmotionCatalogDefinition(emotionType);
      const displayName = String(row?.display_name || catalog?.display_name || row?.emotion_type || '').trim();
      const description = String(row?.description || catalog?.description || '').trim();
      const min = Number.isInteger(Number(row?.scale_min))
        ? Number(row.scale_min)
        : Number(catalog?.scale_min ?? 1);
      const max = Number.isInteger(Number(row?.scale_max))
        ? Number(row.scale_max)
        : Number(catalog?.scale_max ?? 5);
      const scaleMin = Math.min(min, max);
      const scaleMax = Math.max(min, max);
      const configuredEmojiSet = parseEmojiSet(row?.emoji_set);
      let emojiSet = configuredEmojiSet;

      if (emotionType === 'focus' && scaleMin === 1 && scaleMax === 5) {
        emojiSet = ['😶', '🤔', '🎯', '🎯', '🎯'];
      }

      if (!emojiSet.length && Array.isArray(catalog?.emoji_set)) {
        emojiSet = [...catalog.emoji_set];
      }

      const colorScheme = parseColorScheme(row?.color_scheme) || catalog?.color_scheme || null;

      if (!emotionType) return null;

      return {
        emotion_type: emotionType,
        category: row?.category || catalog?.category || null,
        display_name: displayName || emotionType,
        description,
        scale_min: scaleMin,
        scale_max: scaleMax,
        emoji_set: emojiSet,
        color_scheme: colorScheme,
        is_enabled: row?.is_enabled === true,
        order_position: Number.isFinite(Number(row?.order_position)) ? Number(row.order_position) : index + 1
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order_position - b.order_position);
}

function defaultEmotionConfigurations() {
  return normalizeEmotionConfigurations([
    {
      emotion_type: 'mood',
      display_name: 'Humor',
      description: 'Como você está se sentindo hoje?',
      scale_min: 1,
      scale_max: 5,
      emoji_set: ['😢', '😓', '😐', '😊', '🤩'],
      color_scheme: {
        low: 'hsl(0, 70%, 50%)',
        mid: 'hsl(45, 100%, 50%)',
        high: 'hsl(120, 60%, 50%)'
      },
      is_enabled: true,
      order_position: 1
    },
    {
      emotion_type: 'energy',
      display_name: 'Energia',
      description: 'Qual seu nível de energia?',
      scale_min: 1,
      scale_max: 5,
      emoji_set: ['😴', '🥱', '😐', '⚡', '🔥'],
      color_scheme: {
        low: 'hsl(210, 50%, 40%)',
        mid: 'hsl(45, 100%, 50%)',
        high: 'hsl(30, 100%, 50%)'
      },
      is_enabled: true,
      order_position: 2
    },
    {
      emotion_type: 'anxiety',
      display_name: 'Ansiedade',
      description: 'Como está sua ansiedade?',
      scale_min: 1,
      scale_max: 5,
      emoji_set: ['😌', '🙂', '😐', '😟', '😰'],
      color_scheme: {
        low: 'hsl(120, 60%, 50%)',
        mid: 'hsl(45, 100%, 50%)',
        high: 'hsl(0, 70%, 50%)'
      },
      is_enabled: true,
      order_position: 3
    }
  ]);
}

function normalizeEmotionAnswers(rawAnswers = {}) {
  const source = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {};
  const answers = {};

  for (const [key, value] of Object.entries(source)) {
    const emotionType = String(key || '').trim().toLowerCase();
    const n = Number(value);

    if (!emotionType || !Number.isFinite(n)) continue;

    answers[emotionType] = n;
  }

  return answers;
}

function applyLegacyEmotionFields(payload = {}) {
  const emotionAnswers = normalizeEmotionAnswers(payload.emotion_answers || {});

  return {
    ...payload,
    emotion_answers: emotionAnswers,
    mood_score: payload.mood_score ?? emotionAnswers.mood ?? null,
    energy_level: payload.energy_level ?? emotionAnswers.energy ?? null,
    anxiety_level: payload.anxiety_level ?? emotionAnswers.anxiety ?? null
  };
}

function buildEmotionScaleLines(config) {
  const catalog = getEmotionCatalogDefinition(config?.emotion_type);
  const resolvedEmojiSet = Array.isArray(config?.emoji_set) && config.emoji_set.length
    ? config.emoji_set
    : (catalog?.emoji_set || []);
  const min = Number(config?.scale_min ?? 1);
  const max = Number(config?.scale_max ?? 5);
  const lines = [];

  for (let value = min; value <= max; value += 1) {
    const emojiIndex = value - min;
    const emoji = resolvedEmojiSet[emojiIndex] || '';
    lines.push(`${value}${emoji ? ` ${emoji}` : ''}`);
  }

  return lines;
}

function buildStageHeader(stageNumber, stageTotal, title) {
  return `Etapa ${stageNumber} de ${stageTotal} — ${title}`;
}

function emotionQuestion(config, position = 0, total = 1, options = {}) {
  const showStageHeader = options.showStageHeader !== false;
  const stageHeader = showStageHeader
    ? `${buildStageHeader(1, 4, 'Como você está se sentindo')}\n\n`
    : '';
  const description = config?.description ? `\n\n${config.description}` : '';
  const lines = buildEmotionScaleLines(config);
  const min = Number(config?.scale_min ?? 1);
  const max = Number(config?.scale_max ?? 5);

  return `${stageHeader}${position + 1}/${total} • ${config?.display_name || config?.emotion_type || 'Emoção'}${description}\n\n${lines.join('\n')}\n\nResponda com um número entre ${min} e ${max}.`;
}

function formatEmotionSummaryLines(payload = {}) {
  const safePayload = applyLegacyEmotionFields(payload);
  const emotionConfigurations = Array.isArray(safePayload.emotion_configurations)
    ? safePayload.emotion_configurations
    : [];

  if (!emotionConfigurations.length) {
    return [
      `💭 Humor: ${safePayload.mood_score || 'Não informado'}/5`,
      `⚡ Energia: ${safePayload.energy_level || 'Não informado'}/5`,
      `🌧️ Ansiedade: ${safePayload.anxiety_level || 'Não informado'}/5`
    ];
  }

  return emotionConfigurations.map((config) => {
    const score = safePayload.emotion_answers?.[config.emotion_type] ?? null;
    const label = config.display_name || config.emotion_type;

    if (score == null) return `• ${label}: Não informado`;

    return `• ${label}: ${score}/${config.scale_max}`;
  });
}

function parseSleepHours(text) {
  const t = String(text || '').trim().toLowerCase();
  if (['pular', 'skip', 'não', 'nao', 'n', '-'].includes(t)) return { skip: true, value: null };

  const num = parseFloat(t.replace(',', '.'));
  if (Number.isNaN(num) || num < 0 || num > 24) return { error: true };

  return { skip: false, value: num };
}

function parseSleepQuality(text) {
  const t = String(text || '').trim().toLowerCase();
  if (['pular', 'skip', 'não', 'nao', 'n', '-'].includes(t)) return { skip: true, value: null };

  const num = parseInt(t, 10);
  if (Number.isNaN(num) || num < 1 || num > 5) return { error: true };

  return { skip: false, value: num };
}

function sleepHoursQuestion() {
  return `${buildStageHeader(2, 4, 'Sono e descanso')}\n\n😴 *Quantas horas você dormiu na última noite?*\n\nDigite um número (ex: 7 ou 7.5).\nEnvie *pular* se não quiser informar.`;
}

function sleepQualityQuestion() {
  return `${buildStageHeader(2, 4, 'Sono e descanso')}\n\n🛌 *Como foi a qualidade do seu sono?*\n\n1️⃣ Muito ruim\n2️⃣ Ruim\n3️⃣ Regular\n4️⃣ Bom\n5️⃣ Excelente\n\nEnvie *pular* para não informar.`;
}

function contextQuestion(payload = {}) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const mood = Number(safePayload.mood_score || 0);
  const energy = Number(safePayload.energy_level || 0);
  const anxiety = Number(safePayload.anxiety_level || 0);

  let prompt = 'O que mais marcou esse dia?';

  if (anxiety >= 4) {
    prompt = 'Teve algo específico que aumentou sua ansiedade hoje?';
  } else if (mood <= 2) {
    prompt = 'Teve algum momento mais difícil que influenciou seu humor hoje?';
  } else if (energy <= 2) {
    prompt = 'Teve algo que drenou sua energia hoje?';
  } else if (mood >= 4 && energy >= 4 && anxiety <= 2) {
    prompt = 'Que momento positivo mais contribuiu para você se sentir bem hoje?';
  }

  return `${buildStageHeader(3, 4, 'Contexto do dia')}\n\n${prompt}\n\nPode responder com uma palavra ou frase curta.\nExemplo: prova, trabalho, sono ruim, cansaço, apresentação, conversa difícil, dia tranquilo.`;
}

async function httpJson(url, options = {}) {
  const method = options.method || 'GET';
  const timeout = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : HTTP_TIMEOUT_MS;
  const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Number(options.maxRetries)
    : (options.retryOnUnsafe === true || isSafeMethod ? HTTP_MAX_RETRIES : 0);

  const requestOptions = {
    method,
    url,
    timeout,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json'
    },
    json: true
  };

  if (options.body) {
    try {
      requestOptions.body = JSON.parse(options.body);
    } catch (e) {
      requestOptions.body = options.body;
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await n8nHttpRequest(requestOptions);
    } catch (error) {
      const statusCode =
        error?.statusCode ||
        error?.response?.statusCode ||
        error?.response?.status;

      const isNetworkError =
        !statusCode ||
        ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.code);

      const isRetriableStatus = [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(statusCode));
      const shouldRetry = attempt < maxRetries && (isNetworkError || isRetriableStatus);

      if (shouldRetry) {
        const delayMs = HTTP_RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const message =
        error?.response?.body ||
        error?.message ||
        JSON.stringify(error);

      throw new Error(
        `Erro HTTP em ${url} (metodo=${method}, tentativa=${attempt + 1}/${maxRetries + 1}, status=${statusCode || 'n/a'}): ${typeof message === 'string' ? message : JSON.stringify(message)}`
      );
    }
  }
}

async function supabase(path, options = {}) {
  const baseUrl = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const url = `${baseUrl}/rest/v1/${path}`;

  return await httpJson(url, {
    ...options,
    headers: {
      apikey: CFG.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${CFG.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
}

async function logMessage(phone, direction, text, raw = null) {
  try {
    await supabase('whatsapp_messages_log', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        direction,
        message_type: 'text',
        message_text: text,
        raw_payload: raw || {}
      })
    });
  } catch (e) {}
}

async function registerInboundMessage(phone, messageId, rawPayload = {}) {
  const normalizedMessageId = String(messageId || '').trim();

  if (!normalizedMessageId) {
    return { isDuplicate: false, mode: 'no_message_id' };
  }

  if (inboundDedupDisabled) {
    return { isDuplicate: false, mode: 'disabled' };
  }

  try {
    const rows = await supabase('whatsapp_inbound_dedup?on_conflict=message_id', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=representation',
      body: JSON.stringify({
        message_id: normalizedMessageId,
        phone,
        source: 'Diario Emocional - Whatsapp',
        received_at: new Date().toISOString(),
        raw_payload: rawPayload || {}
      }),
      retryOnUnsafe: true
    });

    const inserted = Array.isArray(rows) ? rows.length > 0 : !!rows;

    return { isDuplicate: !inserted, mode: 'table' };
  } catch (error) {
    const message = String(error?.message || '');
    const missingTable = /does not exist|42P01|relation/i.test(message);

    if (missingTable) {
      inboundDedupDisabled = true;
      return { isDuplicate: false, mode: 'missing_table' };
    }

    inboundDedupDisabled = true;
    return { isDuplicate: false, mode: 'error_fallback' };
  }
}

async function checkInboundRateLimit(phone) {
  if (INBOUND_RATE_LIMIT_MAX <= 0 || INBOUND_RATE_LIMIT_WINDOW_SECONDS <= 0) {
    return { allowed: true, mode: 'disabled' };
  }

  const windowStartIso = new Date(Date.now() - INBOUND_RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();

  try {
    const rows = await supabase(
      `whatsapp_messages_log?phone=eq.${encodeURIComponent(phone)}&direction=eq.inbound&created_at=gte.${encodeURIComponent(windowStartIso)}&select=phone&order=created_at.desc&limit=${Math.max(1, INBOUND_RATE_LIMIT_MAX + 1)}`,
      { method: 'GET' }
    );

    const count = Array.isArray(rows) ? rows.length : 0;
    const overBy = Math.max(0, count - INBOUND_RATE_LIMIT_MAX + 1);
    const strike = overBy <= 0 ? 0 : Math.min(6, overBy);
    const suggestedCooldownSeconds = strike <= 0
      ? 0
      : Math.min(
          RATE_LIMIT_COOLDOWN_MAX_SECONDS,
          RATE_LIMIT_COOLDOWN_BASE_SECONDS * Math.pow(2, Math.max(0, strike - 1))
        );

    return {
      allowed: count < INBOUND_RATE_LIMIT_MAX,
      mode: 'table',
      count,
      max: INBOUND_RATE_LIMIT_MAX,
      windowSeconds: INBOUND_RATE_LIMIT_WINDOW_SECONDS,
      suggestedCooldownSeconds
    };
  } catch (_) {
    return { allowed: true, mode: 'error' };
  }
}

async function getActiveRateLimitCooldown(phone) {
  if (inboundRateLimitCooldownDisabled) {
    return { active: false, mode: 'disabled' };
  }

  try {
    const rows = await supabase(
      `whatsapp_rate_limit_cooldowns?phone=eq.${encodeURIComponent(phone)}&blocked_until=gt.now()&select=blocked_until,strike_level,cooldown_seconds&order=blocked_until.desc&limit=1`,
      { method: 'GET' }
    );

    const row = rows?.[0] || null;

    if (!row?.blocked_until) {
      return { active: false, mode: 'table' };
    }

    const remainingMs = new Date(row.blocked_until).getTime() - Date.now();
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

    return {
      active: remainingSeconds > 0,
      mode: 'table',
      remainingSeconds,
      strikeLevel: Number(row.strike_level || 1)
    };
  } catch (error) {
    const message = String(error?.message || '');
    const missingTable = /does not exist|42P01|relation/i.test(message);

    if (missingTable) {
      inboundRateLimitCooldownDisabled = true;
      return { active: false, mode: 'missing_table' };
    }

    return { active: false, mode: 'error' };
  }
}

async function saveRateLimitCooldown(phone, cooldownSeconds, context = {}) {
  if (inboundRateLimitCooldownDisabled || cooldownSeconds <= 0) {
    return { active: cooldownSeconds > 0, mode: 'disabled', remainingSeconds: cooldownSeconds };
  }

  try {
    const active = await getActiveRateLimitCooldown(phone);
    const currentStrikeLevel = Number(active?.strikeLevel || 0);
    const nextStrikeLevel = Math.max(1, currentStrikeLevel + 1);
    const boundedCooldownSeconds = Math.min(
      RATE_LIMIT_COOLDOWN_MAX_SECONDS,
      Math.max(cooldownSeconds, RATE_LIMIT_COOLDOWN_BASE_SECONDS * Math.pow(2, Math.max(0, nextStrikeLevel - 1)))
    );
    const blockedUntilIso = new Date(Date.now() + boundedCooldownSeconds * 1000).toISOString();

    await supabase('whatsapp_rate_limit_cooldowns?on_conflict=phone', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      retryOnUnsafe: true,
      body: JSON.stringify({
        phone,
        strike_level: nextStrikeLevel,
        cooldown_seconds: boundedCooldownSeconds,
        blocked_until: blockedUntilIso,
        reason: 'inbound_rate_limit',
        metadata: {
          source: 'motor_diario_emocional',
          window_seconds: context.windowSeconds || INBOUND_RATE_LIMIT_WINDOW_SECONDS,
          count: context.count ?? null,
          max: context.max ?? INBOUND_RATE_LIMIT_MAX
        },
        updated_at: new Date().toISOString()
      })
    });

    return {
      active: true,
      mode: 'table',
      remainingSeconds: boundedCooldownSeconds,
      strikeLevel: nextStrikeLevel
    };
  } catch (error) {
    const message = String(error?.message || '');
    const missingTable = /does not exist|42P01|relation/i.test(message);

    if (missingTable) {
      inboundRateLimitCooldownDisabled = true;
      return { active: true, mode: 'missing_table', remainingSeconds: cooldownSeconds, strikeLevel: 1 };
    }

    return { active: true, mode: 'error', remainingSeconds: cooldownSeconds, strikeLevel: 1 };
  }
}

async function sendWhatsApp(phone, text) {
  await logMessage(phone, 'outbound', text, null);

  const baseUrl = String(CFG.EVOLUTION_BASE_URL || '').replace(/\/+$/, '');
  const url = `${baseUrl}/message/sendText/${CFG.EVOLUTION_INSTANCE}`;

  return await httpJson(url, {
    method: 'POST',
    headers: {
      apikey: CFG.EVOLUTION_API_KEY
    },
    body: JSON.stringify({
      number: phone,
      text
    })
  });
}

async function sendEmailOtp(to, code) {
  if (!CFG.RESEND_API_KEY || !CFG.FROM_EMAIL) {
    const err = new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
    err.code = 'EMAIL_PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  const subject = 'Código de verificação | Rede Bem-Estar';

  const text = `Seu código de verificação da Rede Bem-Estar é: ${code}\n\nEle expira em 10 minutos.\n\nSe você não solicitou esse código, ignore este e-mail.`;

  return await httpJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.RESEND_API_KEY}`,
      'User-Agent': 'rede-bem-estar-n8n/1.0'
    },
    body: JSON.stringify({
      from: CFG.FROM_EMAIL,
      to: [to],
      subject,
      text
    })
  });
}

async function getLink(phone) {
  const rows = await supabase(
    `whatsapp_profile_links?phone=eq.${encodeURIComponent(phone)}&status=eq.active&select=*`,
    { method: 'GET' }
  );

  return rows?.[0] || null;
}

async function getProfileByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const rows = await supabase(
    `profiles?email=eq.${encodeURIComponent(normalizedEmail)}&select=*&limit=1`,
    { method: 'GET' }
  );

  const profile = rows?.[0] || null;

  if (!profile) return null;

  return {
    id: profile.id,
    user_id: profile.user_id,
    tenant_id: profile.tenant_id || null,
    nome: profile.nome || profile.name || null,
    email: profile.email,
    telefone: profile.telefone || profile.phone || null
  };
}

async function getState(phone) {
  const rows = await supabase(
    `whatsapp_conversation_state?phone=eq.${encodeURIComponent(phone)}&expires_at=gt.now()&select=*&limit=1`,
    { method: 'GET' }
  );

  return rows?.[0] || null;
}

async function upsertState(phone, step, payload, ids = {}, expectedUpdatedAt = null) {
  const safeIds = ids && typeof ids === 'object' ? ids : {};
  const effectiveExpectedUpdatedAt = expectedUpdatedAt || stateTransitionExpectedUpdatedAt || null;
  const row = {
    phone,
    user_id: safeIds.user_id || payload.user_id || null,
    profile_id: safeIds.profile_id || payload.profile_id || null,
    tenant_id: safeIds.tenant_id || payload.tenant_id || null,
    current_step: step,
    payload,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  };

  if (effectiveExpectedUpdatedAt) {
    const rows = await supabase(
      `whatsapp_conversation_state?phone=eq.${encodeURIComponent(phone)}&updated_at=eq.${encodeURIComponent(effectiveExpectedUpdatedAt)}`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify(row),
        retryOnUnsafe: true
      }
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      const conflictError = new Error('STATE_VERSION_CONFLICT');
      conflictError.code = 'STATE_VERSION_CONFLICT';
      throw conflictError;
    }

    if (rows?.[0]?.updated_at) {
      stateTransitionExpectedUpdatedAt = rows[0].updated_at;
    }

    return rows;
  }

  const createdOrMergedRows = await supabase('whatsapp_conversation_state?on_conflict=phone', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row)
  });

  if (createdOrMergedRows?.[0]?.updated_at) {
    stateTransitionExpectedUpdatedAt = createdOrMergedRows[0].updated_at;
  }

  return createdOrMergedRows;
}

async function clearState(phone) {
  return await supabase(
    `whatsapp_conversation_state?phone=eq.${encodeURIComponent(phone)}`,
    { method: 'DELETE' }
  );
}

async function saveOtp(email, phone, codeHash) {
  return await supabase('whatsapp_auth_codes', {
    method: 'POST',
    body: JSON.stringify({
      email,
      phone,
      code_hash: codeHash,
      attempts: 0
    })
  });
}

async function getLatestOtp(email, phone) {
  const rows = await supabase(
    `whatsapp_auth_codes?email=eq.${encodeURIComponent(email)}&phone=eq.${encodeURIComponent(phone)}&verified_at=is.null&expires_at=gt.now()&select=*&order=created_at.desc&limit=1`,
    { method: 'GET' }
  );

  return rows?.[0] || null;
}

async function patchOtp(id, patch) {
  return await supabase(
    `whatsapp_auth_codes?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }
  );
}

async function upsertLink(phone, profile) {
  return await supabase('whatsapp_profile_links?on_conflict=phone', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      phone,
      user_id: profile.user_id,
      profile_id: profile.id || profile.profile_id,
      tenant_id: profile.tenant_id,
      verified_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      status: 'active'
    })
  });
}

async function touchLink(phone) {
  try {
    await supabase(
      `whatsapp_profile_links?phone=eq.${encodeURIComponent(phone)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          last_used_at: new Date().toISOString()
        })
      }
    );
  } catch (e) {}
}

function buildBuddyFallbackMessage(riskLevel) {
  if (['attention', 'alert', 'critical'].includes(String(riskLevel || '').toLowerCase())) {
    return 'Obrigado por compartilhar o que está sentindo. Se isso estiver pesado agora, procure alguém de confiança ou apoio profissional da sua instituição.';
  }

  return 'Obrigado por compartilhar como você está hoje. Que tal fazer uma pausa breve e gentil para respirar e se cuidar um pouco?';
}

function sanitizeBuddyMessage(buddyMessage) {
  const text = String(buddyMessage || '').trim();

  if (!text) return '';

  return text
    .replace(/^Registro salvo com carinho\s*💜\s*/i, '')
    .replace(/^Registro salvo com carinho\s*/i, '')
    .trim();
}

function pickMainPoint(payload = {}) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const context = String(safePayload.day_context || '').trim();

  if (context) return context;

  const candidates = [
    { label: 'humor', value: safePayload.mood_score },
    { label: 'energia', value: safePayload.energy_level },
    { label: 'ansiedade', value: safePayload.anxiety_level != null ? 6 - Number(safePayload.anxiety_level) : null }
  ].filter((item) => Number.isFinite(Number(item.value)));

  if (!candidates.length) return 'rotina do dia';

  candidates.sort((a, b) => Number(a.value) - Number(b.value));
  return candidates[0].label;
}

function buildPostSaveMessage(payload, buddyMessage, streak, total) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const cleanBuddyMessage = sanitizeBuddyMessage(buddyMessage) || buildBuddyFallbackMessage('healthy');
  const mainPoint = pickMainPoint(safePayload);
  const lines = [
    'Registro salvo com carinho 💜',
    '',
    'Resumo do seu registro de hoje',
    '',
    `📌 Ponto principal: ${mainPoint}`,
    `😊 Humor: ${safePayload.mood_score != null ? safePayload.mood_score + '/5' : 'não informado'}`,
    `⚡ Energia: ${safePayload.energy_level != null ? safePayload.energy_level + '/5' : 'não informado'}`,
    `😟 Ansiedade: ${safePayload.anxiety_level != null ? safePayload.anxiety_level + '/5' : 'não informado'}`,
    `😴 Sono: ${safePayload.sleep_hours != null ? safePayload.sleep_hours + 'h' : 'não informado'}`,
    `🛌 Qualidade do sono: ${safePayload.sleep_quality != null ? safePayload.sleep_quality + '/5' : 'não informado'}`,
    '',
    'Leitura do Buddy:',
    cleanBuddyMessage
  ];

  if (total === 1) {
    lines.push('');
    lines.push('🌱 Este é seu primeiro registro. Com mais alguns dias, vou conseguir te ajudar a perceber padrões com mais clareza.');
  }

  const streakMsg = formatStreakMessage(streak, total);
  if (streakMsg) lines.push(streakMsg.trim());

  return lines.join('\n');
}

async function callGpt(payload, riskLevel) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const emotionLines = formatEmotionSummaryLines(safePayload).join('\n');

  const system = `Você é o Buddy da Rede Bem-Estar, um assistente de acolhimento emocional leve para estudantes.\nGere uma resposta curta, humana, acolhedora e segura.\nNão faça diagnóstico.\nNão substitua psicólogo, médico ou atendimento emergencial.\nNão prometa cura.\nSugira no máximo uma ação simples de autocuidado.\nSe o nível estiver como attention, alert ou critical, oriente buscar apoio humano da instituição ou alguém de confiança, sem alarmismo.`;

  const user = `Registro do diário emocional:\nData: ${safePayload.entry_date || todayISO()}\nEmoções:\n${emotionLines}\nContexto: ${safePayload.day_context || ''}\nTexto livre: ${safePayload.free_text || ''}\nRisk level: ${riskLevel}\n\nGere uma mensagem final de até 500 caracteres.`;

  try {
    const data = await httpJson('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CFG.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: CFG.OPENAI_MODEL,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    return (
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      buildBuddyFallbackMessage(riskLevel)
    );
  } catch (_) {
    return buildBuddyFallbackMessage(riskLevel);
  }
}

function classifyRiskLevel(payload) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const mood = Number(safePayload.mood_score || 0);
  const energy = Number(safePayload.energy_level || 0);
  const anxiety = Number(safePayload.anxiety_level || 0);

  if (anxiety >= 5 && mood <= 2 && energy <= 2) return 'alert';
  if (anxiety >= 5 && mood <= 2) return 'attention';

  return 'healthy';
}

async function getExistingMoodEntry(userId, date) {
  const rows = await supabase(
    `mood_entries?user_id=eq.${encodeURIComponent(userId)}&date=eq.${encodeURIComponent(date)}&select=*&limit=1`,
    { method: 'GET' }
  );

  return rows?.[0] || null;
}

async function getExistingMoodAnalysis(moodEntryId) {
  const rows = await supabase(
    `mood_entry_analyses?mood_entry_id=eq.${encodeURIComponent(moodEntryId)}&select=*&order=created_at.desc&limit=1`,
    { method: 'GET' }
  );

  return rows?.[0] || null;
}

async function getMoodEntryByDateWithAnalysis(userId, dateISO) {
  const entry = await getExistingMoodEntry(userId, dateISO);

  if (!entry?.id) return null;

  const analysis = await getExistingMoodAnalysis(entry.id);

  return { entry, analysis };
}

async function getTodayMoodEntryWithAnalysis(userId) {
  return await getMoodEntryByDateWithAnalysis(userId, todayISO());
}

async function getLastMoodEntryWithAnalysis(userId) {
  const rows = await supabase(
    `mood_entries?user_id=eq.${encodeURIComponent(userId)}&select=*&order=date.desc,created_at.desc&limit=1`,
    { method: 'GET' }
  );

  const entry = rows?.[0] || null;

  if (!entry?.id) return null;

  const analysis = await getExistingMoodAnalysis(entry.id);

  return { entry, analysis };
}

async function getUserEmotionConfigurations(userId) {
  const rows = await supabase(
    `emotion_configurations?user_id=eq.${encodeURIComponent(userId)}&is_enabled=eq.true&select=emotion_type,display_name,description,scale_min,scale_max,emoji_set,color_scheme,is_enabled,order_position&order=order_position.asc`,
    { method: 'GET' }
  );

  if (!Array.isArray(rows)) return defaultEmotionConfigurations();

  const normalized = normalizeEmotionConfigurations(rows);

  return normalized.length ? normalized : defaultEmotionConfigurations();
}

function pickEmotionConfigurationsForSession(allConfigs = [], lastData = null, trends = {}, maxExtras = 3) {
  const configs = Array.isArray(allConfigs) ? allConfigs : [];
  if (!configs.length) return [];

  const basics = ['mood', 'energy', 'anxiety'];
  const selectedTypes = new Set();

  for (const basic of basics) {
    const found = configs.find((item) => item.emotion_type === basic);
    if (found) selectedTypes.add(found.emotion_type);
  }

  const extraCandidates = configs.filter((item) => !selectedTypes.has(item.emotion_type));
  const scoredCandidates = extraCandidates.map((item, index) => ({
    item,
    index,
    score: 0
  }));

  const lastPayload = lastData?.entry
    ? applyLegacyEmotionFields(buildPayloadFromExistingEntry(lastData.entry, lastData.analysis))
    : null;

  if (lastPayload) {
    const prevAnswers = normalizeEmotionAnswers(lastPayload.emotion_answers || {});

    for (const candidate of scoredCandidates) {
      const emotionType = candidate.item.emotion_type;
      const value = Number(prevAnswers[emotionType]);
      if (!Number.isFinite(value)) continue;

      if (value <= 2 || value >= 4) {
        candidate.score += 2;
      } else {
        candidate.score += 1;
      }

      const trendData = trends?.custom?.[emotionType];
      if (trendData?.variance && trendData.variance > 1) {
        candidate.score += 1;
      }
    }
  }

  scoredCandidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, maxExtras))
    .forEach((candidate) => selectedTypes.add(candidate.item.emotion_type));

  return configs.filter((item) => selectedTypes.has(item.emotion_type));
}

function parseJournalText(journalText) {
  const text = String(journalText || '');

  const contextMatch = text.match(/Contexto do dia:\s*(.*?)\.\s*Registro livre:/s);
  const freeTextMatch = text.match(/Registro livre:\s*(.*?)\.\s*Canal:/s);

  return {
    day_context: contextMatch?.[1]?.trim() || '',
    free_text: freeTextMatch?.[1]?.trim() || ''
  };
}

function buildPayloadFromExistingEntry(entry, analysis = null) {
  const parsed = parseJournalText(entry.journal_text);
  const raw = analysis?.raw_payload || {};
  const entryEmotionValues = entry?.emotion_values && typeof entry.emotion_values === 'object'
    ? entry.emotion_values
    : {};
  const emotionAnswers = normalizeEmotionAnswers({
    ...(raw.emotion_answers || {}),
    ...(entryEmotionValues || {}),
    mood: entry.mood_score,
    energy: entry.energy_level,
    anxiety: entry.anxiety_level
  });

  return applyLegacyEmotionFields({
    entry_date: entry.date || todayISO(),
    mood_score: entry.mood_score,
    energy_level: entry.energy_level,
    anxiety_level: entry.anxiety_level,
    emotion_answers: emotionAnswers,
    emotion_configurations: Array.isArray(raw.emotion_configurations)
      ? normalizeEmotionConfigurations(raw.emotion_configurations)
      : defaultEmotionConfigurations(),
    sleep_hours: entry.sleep_hours ?? raw.sleep_hours ?? entryEmotionValues.sleep_hours ?? null,
    sleep_quality: entry.sleep_quality ?? raw.sleep_quality ?? entryEmotionValues.sleep_quality ?? null,
    day_context: raw.context || parsed.day_context || '',
    free_text: raw.free_text || parsed.free_text || ''
  });
}

function formatEntrySummary(entry, analysis = null) {
  if (!entry) return 'Nenhum registro encontrado.';

  const payload = applyLegacyEmotionFields(buildPayloadFromExistingEntry(entry, analysis));
  const emotionLines = formatEmotionSummaryLines(payload).join('\n');

  return `📅 Data: ${formatDateBR(entry.date)}\n\n${emotionLines}\n😴 Horas de sono: ${payload.sleep_hours ?? 'Não informado'}\n🛌 Qualidade do sono: ${payload.sleep_quality ? payload.sleep_quality + '/5' : 'Não informado'}\n📝 Contexto: ${payload.day_context || 'Não informado'}\n✏️ Registro: ${payload.free_text || 'Não informado'}`;
}

function formatEntryCompact(entry, analysis = null) {
  if (!entry) return '';
  const payload = applyLegacyEmotionFields(buildPayloadFromExistingEntry(entry, analysis));
  const emotionConfigurations = Array.isArray(payload.emotion_configurations)
    ? payload.emotion_configurations
    : [];

  if (emotionConfigurations.length) {
    const parts = emotionConfigurations.slice(0, 3).map((config) => {
      const score = payload.emotion_answers?.[config.emotion_type] ?? null;
      if (score == null) return null;
      const catalog = getEmotionCatalogDefinition(config.emotion_type);
      const emojiSet = Array.isArray(config.emoji_set) && config.emoji_set.length
        ? config.emoji_set
        : (catalog?.emoji_set || []);
      const emojiIndex = score - (config.scale_min ?? 1);
      const emoji = emojiSet[emojiIndex] || '';
      return `${config.display_name || config.emotion_type}: ${score}/${config.scale_max}${emoji ? ' ' + emoji : ''}`;
    }).filter(Boolean);

    return parts.length ? parts.join(' | ') : '';
  }

  const parts = [];
  if (payload.mood_score != null) parts.push(`Humor: ${payload.mood_score}/5`);
  if (payload.energy_level != null) parts.push(`Energia: ${payload.energy_level}/5`);
  return parts.join(' | ');
}

function formatInitialDiaryMenu(lastData, todayData) {
  const hasLast = !!lastData?.entry;
  const hasToday = !!todayData?.entry;

  const lastText = hasLast
    ? (() => {
        const compact = formatEntryCompact(lastData.entry, lastData.analysis);
        return `Seu último Diário foi em ${formatDateBR(lastData.entry.date)}${compact ? ` — ${compact}` : ''}.`;
      })()
    : 'Ainda não encontrei registros anteriores do seu Diário Emocional.';

  if (!hasToday) {
    return `Olá 💜\n\n${lastText}\n\nAinda não encontrei um Diário Emocional registrado hoje.\n\nO que você deseja fazer?\n\n1️⃣ Registrar Diário Emocional de hoje\n2️⃣ Registrar Diário Emocional de outro dia\n3️⃣ Ver meu último registro\n4️⃣ Cancelar`;
  }

  return `Olá 💜\n\n${lastText}\n\nVocê já registrou seu Diário Emocional hoje.\n\nO que deseja fazer?\n\n1️⃣ Ver registro de hoje\n2️⃣ Ajustar registro de hoje\n3️⃣ Registrar outro dia\n4️⃣ Manter como está`;
}

function formatExistingEntryMessage(entry, analysis = null, label = 'dessa data') {
  const buddyMessage = analysis?.buddy_message
    ? `\n\n💬 Mensagem do Buddy:\n${analysis.buddy_message}`
    : '';

  return `Encontrei um Diário Emocional ${label} 💜\n\nRegistro atual:\n\n${formatEntrySummary(entry, analysis)}${buddyMessage}\n\nO que você deseja fazer?\n\n1️⃣ Mudar uma informação\n2️⃣ Reescrever do zero\n3️⃣ Manter como está`;
}

function askDateForOtherDiary() {
  return `Para qual dia você quer registrar o Diário Emocional?\n\nVocê pode responder assim:\n\n• hoje\n• ontem\n• segunda (ou segunda passada)\n• 25/04/2026\n\nDigite a data desejada.`;
}

async function buildDiaryStartPayload(userId, entryDate) {
  const allEmotionConfigurations = await getUserEmotionConfigurations(userId);
  const lastData = await getLastMoodEntryWithAnalysis(userId);
  const trends = await getWeeklyEmotionTrends(userId);
  const emotionConfigurations = pickEmotionConfigurationsForSession(allEmotionConfigurations, lastData, trends, 3);

  return {
    entry_date: entryDate,
    emotion_configurations: emotionConfigurations,
    emotion_answers: {},
    emotion_cursor: 0
  };
}

function getCurrentEmotionConfig(payload = {}) {
  const emotionConfigurations = Array.isArray(payload.emotion_configurations)
    ? payload.emotion_configurations
    : [];
  const cursor = Number.isInteger(Number(payload.emotion_cursor))
    ? Number(payload.emotion_cursor)
    : 0;

  return {
    emotionConfigurations,
    cursor,
    currentConfig: emotionConfigurations[cursor] || null
  };
}

function editFieldQuestion(payload = {}) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const emotionConfigurations = Array.isArray(safePayload.emotion_configurations)
    ? safePayload.emotion_configurations
    : [];
  const emotionAnswers = normalizeEmotionAnswers(safePayload.emotion_answers || {});
  const lines = ['Qual informação você quer mudar?', ''];
  let index = 1;

  for (const config of emotionConfigurations) {
    const emotionType = String(config.emotion_type || '').toLowerCase();
    const score = emotionAnswers[emotionType]
      ?? (emotionType === 'mood' ? safePayload.mood_score : null)
      ?? (emotionType === 'energy' ? safePayload.energy_level : null)
      ?? (emotionType === 'anxiety' ? safePayload.anxiety_level : null);
    const currentValue = score == null
      ? 'nao informado'
      : `${score}/${config.scale_max}`;

    lines.push(`${index}️⃣ ${config.display_name || config.emotion_type} (atual: ${currentValue})`);
    index += 1;
  }

  lines.push(`${index}️⃣ Horas de sono`);
  index += 1;
  lines.push(`${index}️⃣ Qualidade do sono`);
  index += 1;
  lines.push(`${index}️⃣ Contexto do dia`);
  index += 1;
  lines.push(`${index}️⃣ Registro livre`);
  index += 1;
  lines.push(`${index}️⃣ Voltar para revisão`);

  return lines.join('\n');
}

function getEditFieldFromChoice(text, payload = {}) {
  const t = String(text || '').trim().toLowerCase();
  const emotionConfigurations = Array.isArray(payload.emotion_configurations)
    ? payload.emotion_configurations
    : [];

  if (t === 'cancelar') return 'cancel';

  for (let i = 0; i < emotionConfigurations.length; i += 1) {
    const item = emotionConfigurations[i];
    const position = String(i + 1);
    const name = String(item.display_name || '').toLowerCase();
    const type = String(item.emotion_type || '').toLowerCase();

    if (t === position || (name && t.includes(name)) || (type && t.includes(type))) {
      return `emotion:${item.emotion_type}`;
    }
  }

  const base = emotionConfigurations.length;
  if (t === String(base + 1) || t.includes('horas de sono')) return 'sleep_hours';
  if (t === String(base + 2) || t.includes('qualidade do sono')) return 'sleep_quality';
  if (t === String(base + 3) || t.includes('contexto')) return 'day_context';
  if (t === String(base + 4) || t.includes('registro')) return 'free_text';
  if (t === String(base + 5) || t.includes('voltar')) return 'back_to_confirmation';

  if (t.includes('cancelar')) return 'cancel';

  return null;
}

function questionForEditField(field, payload = {}) {
  if (String(field || '').startsWith('emotion:')) {
    const emotionType = String(field).slice('emotion:'.length);
    const emotionConfigurations = Array.isArray(payload.emotion_configurations)
      ? payload.emotion_configurations
      : [];
    const config = emotionConfigurations.find((item) => item.emotion_type === emotionType);

    if (config) {
      return emotionQuestion(config, 0, 1, { showStageHeader: false }).replace('1/1 • ', '');
    }

    return 'Me responda com um número da escala configurada para essa emoção.';
  }

  if (field === 'sleep_hours') return sleepHoursQuestion();
  if (field === 'sleep_quality') return sleepQualityQuestion();

  if (field === 'day_context') {
    return `Me diga o novo contexto do seu dia.\n\nExemplo: prova, trabalho, sono ruim, cansaço, apresentação, conversa difícil, dia tranquilo.`;
  }

  if (field === 'free_text') {
    return `Escreva o novo registro livre sobre como você se sentiu.\n\nSe quiser deixar em branco, responda "pular".`;
  }

  return 'Me envie a nova informação.';
}

function confirmationMessage(payload, prefix = 'Seu Diário Emocional ficou assim:') {
  const safePayload = applyLegacyEmotionFields(payload);
  const emotionLines = formatEmotionSummaryLines(safePayload).join('\n');

  return `${buildStageHeader(4, 4, 'Revisão')}\n\n${prefix}\n\n📅 Data: ${formatDateBR(safePayload.entry_date || todayISO())}\n${emotionLines}\n😴 Horas de sono: ${safePayload.sleep_hours ?? 'não informado'}\n🛌 Qualidade do sono: ${safePayload.sleep_quality ? safePayload.sleep_quality + '/5' : 'não informado'}\n📝 Contexto: ${safePayload.day_context || 'Não informado'}\n✏️ Registro: ${safePayload.free_text || 'Não informado'}\n\nDeseja salvar?\n1️⃣ Sim, salvar\n2️⃣ Ajustar uma resposta\n3️⃣ Refazer tudo\n4️⃣ Cancelar`;
}

function formatStreakMessage(streak, total) {
  const parts = [];

  if (streak >= 7) {
    parts.push(`\n\n🔥 ${streak} dias seguidos! Que consistência incrível!`);
  } else if (streak >= 2) {
    parts.push(`\n\n🔥 ${streak} dias seguidos!`);
  } else if (total === 1) {
    parts.push('\n\n🌱 Este é o seu primeiro registro! Que começo lindo!');
  }

  const milestones = [7, 14, 30, 60, 100];
  if (milestones.includes(total)) {
    parts.push(`\n\n🏆 ${total} registros no Diário Emocional! Você está construindo algo que vale muito.`);
  }

  return parts.join('');
}

async function getCurrentProfileTenant(userId) {
  const rows = await supabase(
    `profiles?user_id=eq.${encodeURIComponent(userId)}&select=tenant_id&limit=1`,
    { method: 'GET' }
  );

  return rows?.[0]?.tenant_id || null;
}

async function saveReminderPreference(phone, userId, tenantId, enabled = true) {
  try {
    await supabase('whatsapp_reminder_preferences?on_conflict=phone', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: JSON.stringify({
        phone,
        user_id: userId,
        tenant_id: tenantId,
        is_enabled: enabled,
        updated_at: new Date().toISOString()
      })
    });
  } catch (e) {}
}

async function getReminderPreference(phone) {
  try {
    const rows = await supabase(
      `whatsapp_reminder_preferences?phone=eq.${encodeURIComponent(phone)}&select=is_enabled&limit=1`,
      { method: 'GET' }
    );

    return rows?.[0]?.is_enabled ?? null;
  } catch (_) {
    return null;
  }
}

async function getWeeklyEmotionTrends(userId) {
  try {
    const sevenDaysAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    })();

    const rows = await supabase(
      `mood_entries?user_id=eq.${encodeURIComponent(userId)}&date=gte.${encodeURIComponent(sevenDaysAgo)}&select=date,mood_score,energy_level,anxiety_level,emotion_values&order=date.asc`,
      { method: 'GET' }
    );

    if (!Array.isArray(rows) || !rows.length) return {};

    const trends = {
      mood: { values: [], avg: null, min: null, max: null, variance: null },
      energy: { values: [], avg: null, min: null, max: null, variance: null },
      anxiety: { values: [], avg: null, min: null, max: null, variance: null }
    };

    const emotionValues = {};

    for (const row of rows) {
      if (row.mood_score != null) trends.mood.values.push(row.mood_score);
      if (row.energy_level != null) trends.energy.values.push(row.energy_level);
      if (row.anxiety_level != null) trends.anxiety.values.push(row.anxiety_level);

      const entryEmotions = row.emotion_values || {};
      for (const [key, val] of Object.entries(entryEmotions)) {
        if (!emotionValues[key]) emotionValues[key] = [];
        if (Number.isFinite(Number(val))) emotionValues[key].push(Number(val));
      }
    }

    for (const key of ['mood', 'energy', 'anxiety']) {
      const values = trends[key].values;
      if (values.length) {
        trends[key].min = Math.min(...values);
        trends[key].max = Math.max(...values);
        trends[key].avg = values.reduce((a, b) => a + b, 0) / values.length;
        const avgSquaredDiff = values.reduce((sum, val) => sum + Math.pow(val - trends[key].avg, 2), 0);
        trends[key].variance = avgSquaredDiff / values.length;
      }
    }

    for (const [emotionType, values] of Object.entries(emotionValues)) {
      if (values.length) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
        emotionValues[emotionType] = { values, avg, variance };
      }
    }

    return { basics: trends, custom: emotionValues };
  } catch (_) {
    return {};
  }
}

async function getUserStreak(userId) {
  try {
    const rows = await supabase(
      `mood_entries?user_id=eq.${encodeURIComponent(userId)}&select=date&order=date.desc&limit=120`,
      { method: 'GET' }
    );

    if (!Array.isArray(rows) || !rows.length) return 0;

    const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))].sort().reverse();
    let streak = 0;
    let expected = todayISO();

    for (const d of dates) {
      if (d === expected) {
        streak += 1;
        const dt = new Date(expected + 'T00:00:00Z');
        dt.setUTCDate(dt.getUTCDate() - 1);
        expected = dt.toISOString().slice(0, 10);
      } else if (d < expected) {
        break;
      }
    }

    return streak;
  } catch (_) {
    return 0;
  }
}

async function getUserTotalEntries(userId) {
  try {
    const rows = await supabase(
      `mood_entries?user_id=eq.${encodeURIComponent(userId)}&select=date`,
      { method: 'GET' }
    );

    return Array.isArray(rows) ? rows.length : 0;
  } catch (_) {
    return 0;
  }
}

async function buildWeeklySummaryMessage(userId) {
  try {
    const sevenDaysAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    })();

    const rows = await supabase(
      `mood_entries?user_id=eq.${encodeURIComponent(userId)}&date=gte.${encodeURIComponent(sevenDaysAgo)}&select=date,mood_score,energy_level,anxiety_level&order=date.asc`,
      { method: 'GET' }
    );

    if (!Array.isArray(rows) || !rows.length) {
      return 'Ainda não encontrei registros nos últimos 7 dias 💜 Que tal fazer seu primeiro registro hoje? Envie *diário*!';
    }

    const lines = ['📊 *Seu resumo dos últimos 7 dias* 💜', ''];

    for (const row of rows) {
      const mood = row.mood_score != null ? `Humor ${row.mood_score}/5` : null;
      const energy = row.energy_level != null ? `Energia ${row.energy_level}/5` : null;
      const parts = [mood, energy].filter(Boolean).join(', ');
      lines.push(`📅 ${formatDateBR(row.date)}: ${parts || 'sem scores registrados'}`);
    }

    const moodScores = rows.map((r) => r.mood_score).filter((v) => v != null);
    if (moodScores.length >= 2) {
      const avg = (moodScores.reduce((a, b) => a + b, 0) / moodScores.length).toFixed(1);
      lines.push('');
      lines.push(`Média de humor: ${avg}/5`);
    }

    const streak = await getUserStreak(userId);
    if (streak >= 2) lines.push(`🔥 Sequência atual: ${streak} dias seguidos`);

    return lines.join('\n');
  } catch (_) {
    return 'Não consegui buscar seu resumo agora. Tente novamente em instantes 💜';
  }
}

async function saveMoodEntry(link, payload, buddyMessage, riskLevel, rawPayload = {}) {
  const safePayload = applyLegacyEmotionFields(payload || {});
  const targetDate = safePayload.entry_date || todayISO();

  // Fonte da verdade do tenant: profiles.tenant_id.
  // Evita salvar diário/análise com tenant antigo caso o aluno tenha sido movido de instituição.
  const currentTenantId = (await getCurrentProfileTenant(link.user_id)) || link.tenant_id || null;

  // Se o vínculo WhatsApp estiver com tenant antigo, atualiza para manter consistência.
  if (currentTenantId && currentTenantId !== link.tenant_id) {
    await supabase(
      `whatsapp_profile_links?phone=eq.${encodeURIComponent(link.phone)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          tenant_id: currentTenantId,
          last_used_at: new Date().toISOString()
        })
      }
    );

    link.tenant_id = currentTenantId;
  }

  const journalText = `Contexto do dia: ${safePayload.day_context || 'Não informado'}.\nRegistro livre: ${safePayload.free_text || 'Não informado'}.\nCanal: WhatsApp.`;

  const emotionAnswers = normalizeEmotionAnswers(safePayload.emotion_answers || {});

  const emotionValues = {
    ...emotionAnswers,
    mood: safePayload.mood_score,
    energy: safePayload.energy_level,
    anxiety: safePayload.anxiety_level,
    ...(safePayload.sleep_hours != null && { sleep_hours: safePayload.sleep_hours }),
    ...(safePayload.sleep_quality != null && { sleep_quality: safePayload.sleep_quality })
  };

  const tags = safePayload.tags || [];

  const moodEntryPayload = {
    user_id: link.user_id,
    profile_id: link.profile_id,
    tenant_id: currentTenantId,
    date: targetDate,
    mood_score: safePayload.mood_score,
    energy_level: safePayload.energy_level,
    anxiety_level: safePayload.anxiety_level,
    sleep_hours: safePayload.sleep_hours ?? null,
    sleep_quality: safePayload.sleep_quality ?? null,
    journal_text: journalText,
    audio_url: null,
    tags,
    emotion_values: emotionValues,
    updated_at: new Date().toISOString()
  };

  const existingMoodEntry = await getExistingMoodEntry(link.user_id, targetDate);

  let moodEntry;

  if (existingMoodEntry?.id) {
    const updatedRows = await supabase(
      `mood_entries?id=eq.${encodeURIComponent(existingMoodEntry.id)}`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify(moodEntryPayload)
      }
    );

    moodEntry = updatedRows?.[0];
  } else {
    const insertedRows = await supabase('mood_entries', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({
        ...moodEntryPayload,
        created_at: new Date().toISOString()
      })
    });

    moodEntry = insertedRows?.[0];
  }

  if (!moodEntry?.id) {
    throw new Error('Não foi possível recuperar o id da entrada em mood_entries.');
  }

  const analysisPayload = {
    mood_entry_id: moodEntry.id,
    user_id: link.user_id,
    risk_level: riskLevel,
    buddy_message: buddyMessage,
    source: 'Diario Emocional - Whatsapp',
    raw_payload: {
      channel: 'whatsapp',
      source: 'Diario Emocional - Whatsapp',
      entry_date: targetDate,
      tenant_id: currentTenantId,
      context: safePayload.day_context || null,
      free_text: safePayload.free_text || null,
      mood_score: safePayload.mood_score,
      energy_level: safePayload.energy_level,
      anxiety_level: safePayload.anxiety_level,
      emotion_answers: emotionAnswers,
      emotion_configurations: Array.isArray(safePayload.emotion_configurations)
        ? safePayload.emotion_configurations
        : [],
      sleep_hours: safePayload.sleep_hours ?? null,
      sleep_quality: safePayload.sleep_quality ?? null,
      phone: link.phone || null,
      raw_evolution_payload: rawPayload || {}
    }
  };

  const existingAnalysis = await getExistingMoodAnalysis(moodEntry.id);

  if (existingAnalysis?.id) {
    await supabase(
      `mood_entry_analyses?id=eq.${encodeURIComponent(existingAnalysis.id)}`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify(analysisPayload)
      }
    );
  } else {
    await supabase('mood_entry_analyses', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify(analysisPayload)
    });
  }

  return moodEntry;
}

try {
const msg = extractPayload(body);

if (!msg.phone) {
  return [{ json: { ok: false, error: 'Telefone não encontrado no payload da Evolution API.' } }];
}

const dedup = await registerInboundMessage(msg.phone, msg.messageId, msg.raw);

if (dedup.isDuplicate) {
  await logMessage(msg.phone, 'inbound', msg.text, {
    ...(msg.raw || {}),
    dedup_status: 'duplicate_ignored',
    message_id: msg.messageId || null
  });

  return [{ json: { ok: true, duplicate_ignored: true } }];
}

await logMessage(msg.phone, 'inbound', msg.text, {
  ...(msg.raw || {}),
  dedup_status: dedup.mode,
  message_id: msg.messageId || null
});

if (!msg.text) {
  await sendWhatsApp(
    msg.phone,
    'Recebi sua mensagem, mas não consegui ler o texto. Para abrir seu Diário Emocional, envie "diário".'
  );

  return [{ json: { ok: true } }];
}

if (isCancel(msg.textLower)) {
  await clearState(msg.phone);

  await sendWhatsApp(
    msg.phone,
    'Tudo bem, fluxo reiniciado 💜 Quando quiser abrir o Diário Emocional, envie "diário".'
  );

  return [{ json: { ok: true } }];
}

let link = await getLink(msg.phone);
let state = await getState(msg.phone);
stateTransitionExpectedUpdatedAt = state?.updated_at || null;

const activeCooldown = await getActiveRateLimitCooldown(msg.phone);

if (activeCooldown.active) {
  await logMessage(msg.phone, 'inbound', msg.text, {
    ...(msg.raw || {}),
    dedup_status: dedup.mode,
    message_id: msg.messageId || null,
    rate_limited: true,
    cooldown_active: true,
    cooldown_remaining_seconds: activeCooldown.remainingSeconds || null,
    cooldown_strike_level: activeCooldown.strikeLevel || null
  });

  await sendWhatsApp(
    msg.phone,
    `Recebi muitas mensagens seguidas. Para evitar erros, aguarde cerca de ${activeCooldown.remainingSeconds} segundo(s) e me envie novamente.`
  );

  return [{ json: { ok: true, rate_limited: true, cooldown_active: true } }];
}

const rateLimit = await checkInboundRateLimit(msg.phone);

if (!rateLimit.allowed) {
  const cooldown = await saveRateLimitCooldown(
    msg.phone,
    rateLimit.suggestedCooldownSeconds || RATE_LIMIT_COOLDOWN_BASE_SECONDS,
    rateLimit
  );

  await logMessage(msg.phone, 'inbound', msg.text, {
    ...(msg.raw || {}),
    dedup_status: dedup.mode,
    message_id: msg.messageId || null,
    rate_limited: true,
    rate_limit_window_seconds: rateLimit.windowSeconds || null,
    rate_limit_max: rateLimit.max || null,
    rate_limit_count: rateLimit.count || null,
    rate_limit_cooldown_seconds: cooldown.remainingSeconds || null,
    rate_limit_cooldown_mode: cooldown.mode || null,
    rate_limit_cooldown_strike: cooldown.strikeLevel || null
  });

  await sendWhatsApp(
    msg.phone,
    `Recebi muitas mensagens em pouco tempo. Para evitar erro no registro, aguarde cerca de ${cooldown.remainingSeconds || RATE_LIMIT_COOLDOWN_BASE_SECONDS} segundo(s) antes de tentar de novo.`
  );

  return [{ json: { ok: true, rate_limited: true, cooldown_seconds: cooldown.remainingSeconds || RATE_LIMIT_COOLDOWN_BASE_SECONDS } }];
}

if (!link) {
  if (!state) {
    if (!isStartCommand(msg.textLower)) {
      await sendWhatsApp(
        msg.phone,
        'Oi 💜 Para abrir seu Diário Emocional, envie "diário".'
      );

      return [{ json: { ok: true } }];
    }

    await upsertState(msg.phone, 'WAITING_EMAIL', {});

    await sendWhatsApp(
      msg.phone,
      `Oi! Eu sou o Buddy da Rede Bem-Estar 💜\n\nPara proteger seu Diário Emocional, preciso confirmar sua identidade no primeiro acesso.\n\nDigite seu e-mail cadastrado na Rede Bem-Estar.`
    );

    return [{ json: { ok: true } }];
  }

  if (state.current_step === 'WAITING_EMAIL') {
    const email = msg.text.trim().toLowerCase();

    if (!isEmail(email)) {
      await sendWhatsApp(
        msg.phone,
        'Esse e-mail não parece válido. Digite o e-mail cadastrado na Rede Bem-Estar.'
      );

      return [{ json: { ok: true } }];
    }

    let authStep = 'profile_lookup';

    try {
      const profile = await getProfileByEmail(email);

      if (!profile) {
        await sendWhatsApp(
          msg.phone,
          'Não encontrei esse e-mail no cadastro da Rede Bem-Estar. Confira o endereço ou fale com o suporte da instituição.'
        );

        return [{ json: { ok: true } }];
      }

      const code = newOtp();

      authStep = 'otp_hash';
      const codeHash = await hashCode(code);

      authStep = 'otp_save';
      await saveOtp(email, msg.phone, codeHash);

      authStep = 'otp_email';
      await sendEmailOtp(email, code);

      authStep = 'state_update';
      await upsertState(
        msg.phone,
        'WAITING_OTP',
        {
          email,
          user_id: profile.user_id,
          profile_id: profile.id,
          tenant_id: profile.tenant_id,
          nome: profile.nome
        },
        {
          user_id: profile.user_id,
          profile_id: profile.id,
          tenant_id: profile.tenant_id
        }
      );

      await sendWhatsApp(
        msg.phone,
        `Enviei um código de verificação para seu e-mail.\n\nDigite aqui o código de 6 dígitos para continuar. Ele expira em 10 minutos.`
      );

      return [{ json: { ok: true } }];
    } catch (e) {
      const code = String(e?.code || e?.message || '');
      const isProviderError = code.includes('EMAIL_PROVIDER_NOT_CONFIGURED');
      const isHashError = code.includes('OTP_HASH_UNAVAILABLE');

      await sendWhatsApp(
        msg.phone,
        isProviderError || isHashError
          ? 'Não consegui enviar seu código de verificação agora. Pode tentar novamente em instantes? 💜'
          : 'Tive uma instabilidade aqui e não consegui processar agora. Pode tentar novamente em instantes? 💜'
      );

      return [{
        json: {
          ok: false,
          error: 'AUTH_EMAIL_STEP_FAILED',
          auth_step: authStep,
          debug_message: e?.message || 'no message'
        }
      }];
    }
  }

  if (state.current_step === 'WAITING_OTP') {
    const authPayload = state.payload || {};
    const otp = await getLatestOtp(authPayload.email, msg.phone);

    if (!otp) {
      await clearState(msg.phone);

      await sendWhatsApp(
        msg.phone,
        'Seu código expirou. Para começar novamente, envie "diário".'
      );

      return [{ json: { ok: true } }];
    }

    if ((otp.attempts || 0) >= 5) {
      await clearState(msg.phone);

      await sendWhatsApp(
        msg.phone,
        'Muitas tentativas incorretas. Por segurança, comece novamente enviando "diário".'
      );

      return [{ json: { ok: true } }];
    }

    let providedCodeHash;

    try {
      providedCodeHash = await hashCode(msg.text.trim());
    } catch (e) {
      await sendWhatsApp(
        msg.phone,
        'Não consegui validar seu código agora. Pode tentar novamente em instantes? 💜'
      );

      return [{
        json: {
          ok: false,
          error: 'OTP_HASH_UNAVAILABLE',
          auth_step: 'otp_verify_hash',
          debug_message: e?.message || 'no message'
        }
      }];
    }

    if (providedCodeHash !== otp.code_hash) {
      await patchOtp(otp.id, { attempts: (otp.attempts || 0) + 1 });

      await sendWhatsApp(
        msg.phone,
        'Código incorreto. Confira o e-mail e tente novamente.'
      );

      return [{ json: { ok: true } }];
    }

    await patchOtp(otp.id, { verified_at: new Date().toISOString() });

    const profileForLink = {
      user_id: authPayload.user_id,
      id: authPayload.profile_id,
      tenant_id: authPayload.tenant_id
    };

    await upsertLink(msg.phone, profileForLink);

    link = await getLink(msg.phone);

    const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);
    const lastData = await getLastMoodEntryWithAnalysis(link.user_id);

    await upsertState(
      msg.phone,
      'WAITING_INITIAL_DIARY_MENU',
      {
        has_today_entry: !!todayData?.entry,
        today_entry_id: todayData?.entry?.id || null,
        last_entry_id: lastData?.entry?.id || null
      },
      link,
      state?.updated_at || null
    );

    await sendWhatsApp(
      msg.phone,
      'Identidade confirmada com segurança 💜\n\nVamos abrir seu Diário Emocional.'
    );

    await sendWhatsApp(msg.phone, formatInitialDiaryMenu(lastData, todayData));

    return [{ json: { ok: true } }];
  }

  await clearState(msg.phone);

  await sendWhatsApp(
    msg.phone,
    'Vamos começar de novo. Envie "diário" para abrir seu Diário Emocional.'
  );

  return [{ json: { ok: true } }];
}

await touchLink(msg.phone);

if (state && SESSION_STALE_HOURS > 0) {
  const staleThresholdMs = SESSION_STALE_HOURS * 60 * 60 * 1000;
  const stateAgeMs = Date.now() - new Date(state.updated_at).getTime();

  if (stateAgeMs > staleThresholdMs) {
    const hoursAgo = Math.max(1, Math.round(stateAgeMs / (60 * 60 * 1000)));
    await sendWhatsApp(
      msg.phone,
      `💜 Sua sessão estava pausada há ${hoursAgo}h. Continuando de onde parou...`
    );
  }
}

if (isHelp(msg.textLower)) {
  const currentStep = state?.current_step || null;
  const backSteps = ['WAITING_EMOTION_SCORE', 'WAITING_SLEEP_HOURS', 'WAITING_SLEEP_QUALITY', 'WAITING_CONTEXT', 'WAITING_FREE_TEXT'];
  const helpLines = [
    '💜 Comandos disponíveis:',
    '',
    '• *diário* — abrir o Diário Emocional',
    '• *cancelar* — encerrar o fluxo atual'
  ];

  if (currentStep && backSteps.includes(currentStep)) {
    helpLines.push('• *voltar* — retornar ao campo anterior');
  }

  helpLines.push('• *registrar hoje* — iniciar o diário de hoje');
  helpLines.push('• *ajustar hoje* — editar o diário de hoje');
  helpLines.push('• *último registro* — ver seu último diário');
  helpLines.push('• *insights* (ou *resumo*) — ver resumo da semana');
  helpLines.push('• *ativar lembretes* — receber lembretes diários');
  helpLines.push('• *desativar lembretes* — pausar lembretes');
  helpLines.push('• *ajuda* — ver esta mensagem');

  await sendWhatsApp(msg.phone, helpLines.join('\n'));
  return [{ json: { ok: true } }];
}

if (isResumo(msg.textLower) || isInsightsCommand(msg.textLower)) {
  const summaryMsg = await buildWeeklySummaryMessage(link.user_id);
  await sendWhatsApp(msg.phone, summaryMsg);
  return [{ json: { ok: true } }];
}

if (isUltimoRegistroCommand(msg.textLower)) {
  const lastData = await getLastMoodEntryWithAnalysis(link.user_id);

  if (!lastData?.entry) {
    await sendWhatsApp(msg.phone, 'Ainda não encontrei registros anteriores no seu Diário Emocional.');
    return [{ json: { ok: true } }];
  }

  await sendWhatsApp(msg.phone, `Seu último registro 💜\n\n${formatEntrySummary(lastData.entry, lastData.analysis)}`);
  return [{ json: { ok: true } }];
}

if (isAjustarHojeCommand(msg.textLower)) {
  const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);

  if (!todayData?.entry) {
    const startPayload = await buildDiaryStartPayload(link.user_id, todayISO());
    await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', startPayload, link);
    await sendWhatsApp(msg.phone, `Ainda não encontrei um Diário Emocional registrado hoje. Vamos criar agora 💜\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`);
    return [{ json: { ok: true } }];
  }

  const existingPayload = buildPayloadFromExistingEntry(todayData.entry, todayData.analysis);
  await upsertState(
    msg.phone,
    'WAITING_EXISTING_ENTRY_CHOICE',
    {
      existing_mood_entry_id: todayData.entry.id,
      existing_analysis_id: todayData.analysis?.id || null,
      entry_date: todayISO(),
      ...existingPayload
    },
    link
  );

  await sendWhatsApp(msg.phone, formatExistingEntryMessage(todayData.entry, todayData.analysis, 'de hoje'));
  return [{ json: { ok: true } }];
}

if (isRegistrarHojeCommand(msg.textLower)) {
  const startPayload = await buildDiaryStartPayload(link.user_id, todayISO());
  await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', startPayload, link);
  await sendWhatsApp(msg.phone, `Vamos registrar seu Diário Emocional de hoje 💜\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`);
  return [{ json: { ok: true } }];
}

if (!state) {
  if (!isStartCommand(msg.textLower)) {
    await sendWhatsApp(
      msg.phone,
      'Oi 💜 Para abrir seu Diário Emocional, envie "diário".'
    );

    return [{ json: { ok: true } }];
  }

  const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);
  const lastData = await getLastMoodEntryWithAnalysis(link.user_id);

  await upsertState(
    msg.phone,
    'WAITING_INITIAL_DIARY_MENU',
    {
      has_today_entry: !!todayData?.entry,
      today_entry_id: todayData?.entry?.id || null,
      last_entry_id: lastData?.entry?.id || null
    },
    link
  );

  await sendWhatsApp(
    msg.phone,
    formatInitialDiaryMenu(lastData, todayData)
  );

  return [{ json: { ok: true } }];
}

const payload = state.payload || {};

if (state.current_step === 'WAITING_INITIAL_DIARY_MENU') {
  const choice = msg.textLower;
  const hasTodayEntry = payload.has_today_entry === true;

  if (choice === '3' || choice.includes('outro')) {
    if (hasTodayEntry) {
      await upsertState(msg.phone, 'WAITING_OTHER_DIARY_DATE', payload, link);
      await sendWhatsApp(msg.phone, askDateForOtherDiary());
      return [{ json: { ok: true } }];
    }

    const lastData = await getLastMoodEntryWithAnalysis(link.user_id);
    if (!lastData?.entry) {
      await sendWhatsApp(msg.phone, 'Ainda não encontrei registros anteriores. Vamos criar seu primeiro Diário Emocional de hoje? 💜');
      return [{ json: { ok: true } }];
    }

    const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);
    await sendWhatsApp(
      msg.phone,
      `Seu último registro foi este 💜\n\n${formatEntrySummary(lastData.entry, lastData.analysis)}`
    );
    await sendWhatsApp(msg.phone, formatInitialDiaryMenu(lastData, todayData));
    return [{ json: { ok: true } }];
  }

  if ((choice === '2' || choice.includes('ajustar') || choice.includes('editar')) && hasTodayEntry) {
    const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);

    if (!todayData?.entry) {
      await sendWhatsApp(msg.phone, 'Não encontrei um registro de hoje para ajustar.');
      return [{ json: { ok: true } }];
    }

    const existingPayload = buildPayloadFromExistingEntry(todayData.entry, todayData.analysis);

    await upsertState(
      msg.phone,
      'WAITING_EXISTING_ENTRY_CHOICE',
      {
        existing_mood_entry_id: todayData.entry.id,
        existing_analysis_id: todayData.analysis?.id || null,
        entry_date: todayISO(),
        ...existingPayload
      },
      link
    );

    await sendWhatsApp(
      msg.phone,
      formatExistingEntryMessage(todayData.entry, todayData.analysis, 'de hoje')
    );

    return [{ json: { ok: true } }];
  }

  if ((choice === '2' || choice.includes('outro')) && !hasTodayEntry) {
    await upsertState(msg.phone, 'WAITING_OTHER_DIARY_DATE', payload, link);
    await sendWhatsApp(msg.phone, askDateForOtherDiary());
    return [{ json: { ok: true } }];
  }

  if ((choice === '1' || choice.includes('hoje')) && hasTodayEntry) {
    const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);

    if (todayData?.entry) {
      await sendWhatsApp(
        msg.phone,
        `Seu registro de hoje 💜\n\n${formatEntrySummary(todayData.entry, todayData.analysis)}`
      );
      await sendWhatsApp(msg.phone, formatInitialDiaryMenu(await getLastMoodEntryWithAnalysis(link.user_id), todayData));
      return [{ json: { ok: true } }];
    }
  }

  if (choice === '1' || choice.includes('hoje') || (hasTodayEntry && choice.includes('registrar'))) {
    const startPayload = await buildDiaryStartPayload(link.user_id, todayISO());

    await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', startPayload, link);

    await sendWhatsApp(
      msg.phone,
      `Vamos registrar seu Diário Emocional de hoje 💜\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`
    );

    return [{ json: { ok: true } }];
  }

  if (
    choice === '4' ||
    choice.includes('manter') ||
    choice.includes('cancelar') ||
    choice.includes('nada')
  ) {
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      'Tudo certo 💜 Mantive seus registros como estão. Quando quiser abrir o Diário Emocional novamente, envie "diário".'
    );

    return [{ json: { ok: true } }];
  }

  const todayData = await getTodayMoodEntryWithAnalysis(link.user_id);
  const lastData = await getLastMoodEntryWithAnalysis(link.user_id);

  await sendWhatsApp(msg.phone, formatInitialDiaryMenu(lastData, todayData));
  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_OTHER_DIARY_DATE') {
  const selectedDate = parseDateInput(msg.text);

  if (!selectedDate) {
    await sendWhatsApp(
      msg.phone,
      `Não consegui entender a data. 😕\n\nVocê pode responder assim:\n• hoje\n• ontem\n• segunda, terça, quarta...\n• segunda passada, sexta passada...\n• 25/04/2026`
    );

    return [{ json: { ok: true } }];
  }

  if (isFutureDate(selectedDate)) {
    await sendWhatsApp(
      msg.phone,
      'Essa data ainda não chegou. Para o Diário Emocional, escolha hoje ou uma data anterior.'
    );

    return [{ json: { ok: true } }];
  }

  const selectedData = await getMoodEntryByDateWithAnalysis(link.user_id, selectedDate);

  if (selectedData?.entry) {
    const existingPayload = buildPayloadFromExistingEntry(selectedData.entry, selectedData.analysis);

    await upsertState(
      msg.phone,
      'WAITING_EXISTING_ENTRY_CHOICE',
      {
        existing_mood_entry_id: selectedData.entry.id,
        existing_analysis_id: selectedData.analysis?.id || null,
        entry_date: selectedDate,
        ...existingPayload
      },
      link
    );

    await sendWhatsApp(
      msg.phone,
      formatExistingEntryMessage(
        selectedData.entry,
        selectedData.analysis,
        `de ${formatDateBR(selectedDate)}`
      )
    );

    return [{ json: { ok: true } }];
  }

  const startPayload = await buildDiaryStartPayload(link.user_id, selectedDate);

  await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', startPayload, link);

  await sendWhatsApp(
    msg.phone,
    `Certo 💜 Vamos registrar seu Diário Emocional de ${formatDateBR(selectedDate)}.\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`
  );

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_EXISTING_ENTRY_CHOICE') {
  const choice = msg.textLower;

  if (
    choice === '1' ||
    choice.includes('mudar') ||
    choice.includes('alterar') ||
    choice.includes('editar')
  ) {
    await upsertState(msg.phone, 'WAITING_EDIT_FIELD', payload, link);
    await sendWhatsApp(msg.phone, editFieldQuestion(payload));
    return [{ json: { ok: true } }];
  }

  if (
    choice === '2' ||
    choice.includes('reescrever') ||
    choice.includes('refazer') ||
    choice.includes('zero')
  ) {
    const startPayload = await buildDiaryStartPayload(
      link.user_id,
      payload.entry_date || todayISO()
    );

    await upsertState(
      msg.phone,
      'WAITING_EMOTION_SCORE',
      startPayload,
      link
    );

    await sendWhatsApp(
      msg.phone,
      `Sem problema. Vamos reescrever esse Diário Emocional do zero 💜\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`
    );

    return [{ json: { ok: true } }];
  }

  if (
    choice === '3' ||
    choice.includes('manter') ||
    choice.includes('nada') ||
    choice.includes('cancelar')
  ) {
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      'Tudo certo 💜 Mantive esse Diário Emocional como está.'
    );

    return [{ json: { ok: true } }];
  }

  await sendWhatsApp(
    msg.phone,
    `Me responda com uma das opções:\n\n1️⃣ Mudar uma informação\n2️⃣ Reescrever do zero\n3️⃣ Manter como está`
  );

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_EDIT_FIELD') {
  const editField = getEditFieldFromChoice(msg.textLower, payload);

  if (editField === 'cancel') {
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      'Edição cancelada 💜 Mantive seu Diário Emocional como estava.'
    );

    return [{ json: { ok: true } }];
  }

  if (editField === 'back_to_confirmation') {
    await upsertState(msg.phone, 'WAITING_CONFIRMATION', payload, link);
    await sendWhatsApp(msg.phone, confirmationMessage(payload));
    return [{ json: { ok: true } }];
  }

  if (!editField) {
    await sendWhatsApp(
      msg.phone,
      `Não consegui identificar qual campo você quer mudar.\n\n${editFieldQuestion(payload)}`
    );

    return [{ json: { ok: true } }];
  }

  await upsertState(
    msg.phone,
    'WAITING_EDIT_VALUE',
    {
      ...payload,
      edit_field: editField
    },
    link
  );

  await sendWhatsApp(msg.phone, questionForEditField(editField, payload));
  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_EDIT_VALUE') {
  const editField = payload.edit_field;

  if (!editField) {
    await upsertState(msg.phone, 'WAITING_EDIT_FIELD', payload, link);

    await sendWhatsApp(
      msg.phone,
      `Não encontrei qual campo estava sendo editado.\n\n${editFieldQuestion(payload)}`
    );

    return [{ json: { ok: true } }];
  }

  const updatedPayload = { ...payload };
  delete updatedPayload.edit_field;

  if (String(editField || '').startsWith('emotion:')) {
    const emotionType = String(editField).slice('emotion:'.length);
    const emotionConfigurations = Array.isArray(payload.emotion_configurations)
      ? payload.emotion_configurations
      : [];
    const config = emotionConfigurations.find((item) => item.emotion_type === emotionType);
    const scaleMin = config?.scale_min ?? 1;
    const scaleMax = config?.scale_max ?? 5;
    const n = parseScaleNumber(msg.textLower, scaleMin, scaleMax);

    if (!n) {
      await sendWhatsApp(
        msg.phone,
        `Me responda com um número entre ${scaleMin} e ${scaleMax}, por favor 💜\n\n${questionForEditField(editField, payload)}`
      );

      return [{ json: { ok: true } }];
    }

    updatedPayload.emotion_answers = normalizeEmotionAnswers({
      ...(updatedPayload.emotion_answers || {}),
      [emotionType]: n
    });

    if (emotionType === 'mood') updatedPayload.mood_score = n;
    if (emotionType === 'energy') updatedPayload.energy_level = n;
    if (emotionType === 'anxiety') updatedPayload.anxiety_level = n;
  } else if (editField === 'sleep_hours') {
    const parsed = parseSleepHours(msg.text);

    if (parsed.error) {
      await sendWhatsApp(
        msg.phone,
        `❌ Valor inválido.\n\n    ${questionForEditField(editField, payload)}`
      );

      return [{ json: { ok: true } }];
    }

    updatedPayload.sleep_hours = parsed.value;
  } else if (editField === 'sleep_quality') {
    const parsed = parseSleepQuality(msg.text);

    if (parsed.error) {
      await sendWhatsApp(
        msg.phone,
        `❌ Valor inválido.\n\n    ${questionForEditField(editField, payload)}`
      );

      return [{ json: { ok: true } }];
    }

    updatedPayload.sleep_quality = parsed.value;
  } else if (editField === 'free_text') {
    updatedPayload.free_text = ['pular', 'não', 'nao', 'n'].includes(msg.textLower)
      ? ''
      : msg.text.trim();
  } else if (editField === 'day_context') {
    updatedPayload.day_context = msg.text.trim();
  }

  await upsertState(msg.phone, 'WAITING_CONFIRMATION', updatedPayload, link);

  await sendWhatsApp(
    msg.phone,
    confirmationMessage(updatedPayload, 'Atualizei essa informação. Seu Diário Emocional ficou assim:')
  );

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_EMOTION_SCORE') {
  const { emotionConfigurations, cursor, currentConfig } = getCurrentEmotionConfig(payload);

  if (isBack(msg.textLower)) {
    if (cursor > 0) {
      const prevCursor = cursor - 1;
      const prevConfig = emotionConfigurations[prevCursor];
      await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', { ...payload, emotion_cursor: prevCursor }, link);
      await sendWhatsApp(msg.phone, emotionQuestion(prevConfig, prevCursor, emotionConfigurations.length));
    } else {
      await sendWhatsApp(
        msg.phone,
        'Você já está na primeira pergunta 💜 Responda com um número ou envie *cancelar* para encerrar.'
      );
    }
    return [{ json: { ok: true } }];
  }

  if (!currentConfig) {
    const fallbackStartPayload = await buildDiaryStartPayload(
      link.user_id,
      payload.entry_date || todayISO()
    );

    await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', fallbackStartPayload, link);

    await sendWhatsApp(
      msg.phone,
      emotionQuestion(
        fallbackStartPayload.emotion_configurations[0],
        0,
        fallbackStartPayload.emotion_configurations.length
      )
    );

    return [{ json: { ok: true } }];
  }

  const score = parseScaleNumber(msg.textLower, currentConfig.scale_min, currentConfig.scale_max);

  if (!score) {
    await sendWhatsApp(
      msg.phone,
      `Me responda com um número entre ${currentConfig.scale_min} e ${currentConfig.scale_max}, por favor 💜\n\n${emotionQuestion(currentConfig, cursor, emotionConfigurations.length)}`
    );

    return [{ json: { ok: true } }];
  }

  const updatedEmotionAnswers = normalizeEmotionAnswers({
    ...(payload.emotion_answers || {}),
    [currentConfig.emotion_type]: score
  });

  const nextPayload = applyLegacyEmotionFields({
    ...payload,
    emotion_answers: updatedEmotionAnswers,
    emotion_cursor: cursor + 1
  });

  const nextConfig = emotionConfigurations[cursor + 1];

  if (nextConfig) {
    await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', nextPayload, link);

    await sendWhatsApp(
      msg.phone,
      emotionQuestion(nextConfig, cursor + 1, emotionConfigurations.length)
    );

    return [{ json: { ok: true } }];
  }

  await upsertState(msg.phone, 'WAITING_SLEEP_HOURS', nextPayload, link);
  await sendWhatsApp(msg.phone, sleepHoursQuestion());

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_SLEEP_HOURS') {
  if (isBack(msg.textLower)) {
    const emotionConfigurations = Array.isArray(payload.emotion_configurations) ? payload.emotion_configurations : [];
    const lastCursor = Math.max(0, emotionConfigurations.length - 1);
    const lastConfig = emotionConfigurations[lastCursor];

    if (lastConfig) {
      await upsertState(msg.phone, 'WAITING_EMOTION_SCORE', { ...payload, emotion_cursor: lastCursor }, link);
      await sendWhatsApp(msg.phone, emotionQuestion(lastConfig, lastCursor, emotionConfigurations.length));
    } else {
      await sendWhatsApp(msg.phone, 'Não foi possível voltar. Responda com as horas de sono ou envie *cancelar*.');
    }
    return [{ json: { ok: true } }];
  }

  const parsed = parseSleepHours(msg.text);

  if (parsed.error) {
    await sendWhatsApp(
      msg.phone,
      `❌ Valor inválido. ${sleepHoursQuestion()}`
    );

    return [{ json: { ok: true } }];
  }

  await upsertState(
    msg.phone,
    'WAITING_SLEEP_QUALITY',
    {
      ...payload,
      sleep_hours: parsed.value
    },
    link
  );

  await sendWhatsApp(msg.phone, sleepQualityQuestion());

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_SLEEP_QUALITY') {
  if (isBack(msg.textLower)) {
    await upsertState(msg.phone, 'WAITING_SLEEP_HOURS', payload, link);
    await sendWhatsApp(msg.phone, sleepHoursQuestion());
    return [{ json: { ok: true } }];
  }

  const parsed = parseSleepQuality(msg.text);

  if (parsed.error) {
    await sendWhatsApp(
      msg.phone,
      `❌ Valor inválido. ${sleepQualityQuestion()}`
    );

    return [{ json: { ok: true } }];
  }

  await upsertState(
    msg.phone,
    'WAITING_CONTEXT',
    {
      ...payload,
      sleep_quality: parsed.value
    },
    link
  );

  await sendWhatsApp(msg.phone, contextQuestion({ ...payload, sleep_quality: parsed.value }));

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_CONTEXT') {
  if (isBack(msg.textLower)) {
    await upsertState(msg.phone, 'WAITING_SLEEP_QUALITY', payload, link);
    await sendWhatsApp(msg.phone, sleepQualityQuestion());
    return [{ json: { ok: true } }];
  }

  await upsertState(
    msg.phone,
    'WAITING_FREE_TEXT',
    {
      ...payload,
      day_context: msg.text.trim()
    },
    link
  );

  await sendWhatsApp(
    msg.phone,
    `Quer registrar algo mais sobre como você se sentiu?\n\nPode escrever livremente ou responder "pular".`
  );

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_FREE_TEXT') {
  if (isBack(msg.textLower)) {
    await upsertState(msg.phone, 'WAITING_CONTEXT', payload, link);
    await sendWhatsApp(msg.phone, contextQuestion(payload));
    return [{ json: { ok: true } }];
  }

  const freeText = ['pular', 'não', 'nao', 'n'].includes(msg.textLower)
    ? ''
    : msg.text.trim();

  const finalPayload = {
    ...payload,
    free_text: freeText
  };

  await upsertState(msg.phone, 'WAITING_CONFIRMATION', finalPayload, link);

  await sendWhatsApp(
    msg.phone,
    confirmationMessage(finalPayload)
  );

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_CONFIRMATION') {
  if (msg.textLower === '2' || msg.textLower.includes('ajustar')) {
    await upsertState(msg.phone, 'WAITING_EDIT_FIELD', payload, link);
    await sendWhatsApp(msg.phone, editFieldQuestion(payload));
    return [{ json: { ok: true } }];
  }

  if (msg.textLower === '3' || msg.textLower === 'refazer') {
    const startPayload = await buildDiaryStartPayload(
      link.user_id,
      payload.entry_date || todayISO()
    );

    await upsertState(
      msg.phone,
      'WAITING_EMOTION_SCORE',
      startPayload,
      link
    );

    await sendWhatsApp(
      msg.phone,
      `Sem problema. Vamos refazer 💜\n\n${emotionQuestion(startPayload.emotion_configurations[0], 0, startPayload.emotion_configurations.length)}`
    );

    return [{ json: { ok: true } }];
  }

  if (msg.textLower === '4' || msg.textLower === 'cancelar') {
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      'Registro cancelado 💜 Quando quiser, envie "diário" para começar de novo.'
    );

    return [{ json: { ok: true } }];
  }

  if (msg.textLower !== '1' && msg.textLower !== 'sim') {
    await sendWhatsApp(
      msg.phone,
      `Me responda com:\n1️⃣ para salvar\n2️⃣ para ajustar uma resposta\n3️⃣ para refazer tudo\n4️⃣ para cancelar`
    );

    return [{ json: { ok: true } }];
  }

  const riskLevel = classifyRiskLevel(payload);
  const buddyMessage = await callGpt(payload, riskLevel);

  await saveMoodEntry(link, payload, buddyMessage, riskLevel, msg.raw);
  await clearState(msg.phone);

  const [streak, total] = await Promise.all([
    getUserStreak(link.user_id),
    getUserTotalEntries(link.user_id)
  ]);

  await sendWhatsApp(
    msg.phone,
    buildPostSaveMessage(payload, buddyMessage, streak, total)
  );

  if (riskLevel === 'alert') {
    await sendWhatsApp(
      msg.phone,
      `💜 Quando as coisas ficam pesadas assim, não precisamos carregar sozinhos.\n\nSe precisar de apoio agora:\n📞 CVV: 188 (24h, gratuito)\n💬 cvv.org.br\n\nVocê pode conversar com alguém de confiança ou com um profissional da sua instituição.`
    );
  }

  if (total === 1) {
    const reminderPref = await getReminderPreference(msg.phone);
    if (reminderPref === null) {
      await sendWhatsApp(
        msg.phone,
        `💜 Que legal! Seu registro foi guardado com carinho.\n\nDeseja receber lembretes diários para manter seu Diário Emocional em dia?\n\n1️⃣ Sim, ativar lembretes\n2️⃣ Não, obrigado\n\nVocê pode mudar isso depois com *ativar lembretes* ou *desativar lembretes*.`
      );

      await upsertState(
        msg.phone,
        'WAITING_REMINDER_PREFERENCE',
        { reminder_prompt_shown: true },
        link
      );

      return [{ json: { ok: true } }];
    }
  }

  return [{ json: { ok: true } }];
}

if (state.current_step === 'WAITING_REMINDER_PREFERENCE') {
  const choice = msg.textLower;

  if (choice === '1' || choice.includes('sim') || choice.includes('ativar')) {
    await saveReminderPreference(msg.phone, link.user_id, link.tenant_id, true);
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      '✅ Lembretes ativados! Você receberá notificações para manter seu Diário Emocional em dia 💜'
    );

    return [{ json: { ok: true } }];
  }

  if (choice === '2' || choice.includes('não') || choice.includes('nao') || choice.includes('obrigado')) {
    await saveReminderPreference(msg.phone, link.user_id, link.tenant_id, false);
    await clearState(msg.phone);

    await sendWhatsApp(
      msg.phone,
      'Tudo bem! Você pode ativar lembretes depois com *ativar lembretes* 💜'
    );

    return [{ json: { ok: true } }];
  }

  await sendWhatsApp(
    msg.phone,
    `Me responda com:\n1️⃣ para ativar lembretes\n2️⃣ para não ativar`
  );

  return [{ json: { ok: true } }];
}

if (isReminderEnableCommand(msg.textLower) && !state) {
  await saveReminderPreference(msg.phone, link.user_id, link.tenant_id, true);

  await sendWhatsApp(
    msg.phone,
    '✅ Lembretes ativados com sucesso 💜'
  );

  return [{ json: { ok: true } }];
}

if (isReminderDisableCommand(msg.textLower) && !state) {
  await saveReminderPreference(msg.phone, link.user_id, link.tenant_id, false);

  await sendWhatsApp(
    msg.phone,
    '❌ Lembretes desativados. Você pode ativá-los depois com *ativar lembretes* 💜'
  );

  return [{ json: { ok: true } }];
}

await clearState(msg.phone);

await sendWhatsApp(
  msg.phone,
  'Não consegui reconhecer a etapa atual. Reiniciei o fluxo. Envie "diário" para começar novamente.'
);

return [{ json: { ok: true } }];
} catch (e) {
  const isStateConflict = String(e?.code || e?.message || '').includes('STATE_VERSION_CONFLICT');
  const errorLog = {
    workflow: 'ai-agent-diario-emocional',
    node: 'Motor Diário Emocional',
    error_code: isStateConflict ? 'STATE_VERSION_CONFLICT' : 'MOTOR_UNHANDLED_ERROR',
    message: e?.message || 'Unknown error',
    timestamp: new Date().toISOString()
  };
  try {
    await supabase('workflow_error_logs', {
      method: 'POST',
      body: JSON.stringify(errorLog)
    });
  } catch (_) {}
  try {
    const fallbackPhone = extractPayload(body).phone;
    if (fallbackPhone) {
      await sendWhatsApp(
        fallbackPhone,
        isStateConflict
          ? 'Recebi mensagens quase ao mesmo tempo e preciso que você envie novamente para garantir o registro correto.'
          : 'Tive uma instabilidade aqui e não consegui processar agora. Pode tentar novamente em instantes? 💜'
      );
    }
  } catch (_) {}
  return [{ json: { ok: false, error: isStateConflict ? 'STATE_VERSION_CONFLICT' : 'MOTOR_UNHANDLED_ERROR', debug_message: e?.message || 'no message' } }];
}


``
