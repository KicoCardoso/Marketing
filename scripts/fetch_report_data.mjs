// Busca dados do Relatório (Meta Ads + funil Clint/AspektoApp) e grava docs/report_data.json,
// pro dashboard público (docs/index.html) conseguir montar a aba "Relatório" sem depender
// do Cowork (que só funciona dentro da conversa com o Claude).
//
// Precisa de dois secrets no GitHub Actions:
//   META_ADS_ACCESS_TOKEN — token de acesso Meta com permissão de leitura de Insights (ads_read)
//                            na conta de anúncios abaixo. Pode ser o mesmo token usado na
//                            Conversions API (META_CAPI_ACCESS_TOKEN) SE ele também tiver
//                            permissão ads_read — não temos garantia disso, testar antes de
//                            agendar (ver instruções no final do arquivo/README).
//   CLICKUP_TOKEN         — já existente (mesmo usado no fetch_clickup.mjs).

const META_TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const AD_ACCOUNT_ID = 'act_898197595348538'; // conta "Kico" — Clínica Aspekto - BH (Meta Ads)
const META_API_VERSION = 'v25.0';
const CLINT_METRICS_TASK_ID = '86ajmg6cz';
const WON_MIN_VALUE = 2000;

if (!META_TOKEN) {
  console.error('META_ADS_ACCESS_TOKEN não definido — configure esse secret no repositório (Settings > Secrets and variables > Actions).');
  process.exit(1);
}
if (!CLICKUP_TOKEN) {
  console.error('CLICKUP_TOKEN não definido.');
  process.exit(1);
}

// Datas em horário de Brasília (UTC-3), consistente com o resto do projeto.
function brDateParts(d) {
  const utcMs = d.getTime() - 3 * 3600 * 1000;
  const br = new Date(utcMs);
  return { y: br.getUTCFullYear(), m: br.getUTCMonth(), day: br.getUTCDate() };
}
function isoDate(y, m, day) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const now = new Date();
const { y: curY, m: curM, day: curDay } = brDateParts(now);
const monthStartIso = isoDate(curY, curM, 1);
const todayIso = isoDate(curY, curM, curDay);

async function metaApi(path, params) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Meta Graph API ${path} -> ${res.status} ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

function sumAction(actions, matcher) {
  if (!Array.isArray(actions)) return 0;
  return actions.filter(a => matcher(a.action_type || '')).reduce((sum, a) => sum + (Number(a.value) || 0), 0);
}
function isMessagingActionType(t) { return /messag/i.test(t); }

function parseNum(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

async function fetchAccountInsights(since, until, timeIncrement) {
  const params = {
    fields: 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,video_p25_watched_actions,video_p50_watched_actions,video_p95_watched_actions,video_play_actions',
    level: 'account',
    time_range: { since, until },
    limit: 500
  };
  if (timeIncrement) params.time_increment = String(timeIncrement);
  const res = await metaApi(`/${AD_ACCOUNT_ID}/insights`, params);
  return res.data || [];
}

async function fetchCampaignInsights(since, until) {
  const params = {
    fields: 'id,name,status,objective,spend,impressions,clicks,ctr,cpc,cpm,actions',
    level: 'campaign',
    time_range: { since, until },
    limit: 200
  };
  const res = await metaApi(`/${AD_ACCOUNT_ID}/insights`, params);
  return res.data || [];
}

function summarizeAccountRow(row) {
  if (!row) return null;
  const actions = row.actions || [];
  const msgCount = sumAction(actions, isMessagingActionType);
  const spend = parseNum(row.spend);
  return {
    spend,
    impressions: parseNum(row.impressions),
    clicks: parseNum(row.clicks),
    ctr: parseNum(row.ctr),
    cpc: parseNum(row.cpc),
    cpm: parseNum(row.cpm),
    reach: parseNum(row.reach),
    frequency: parseNum(row.frequency),
    videoP25: sumAction(row.video_p25_watched_actions, () => true),
    videoP50: sumAction(row.video_p50_watched_actions, () => true),
    videoP95: sumAction(row.video_p95_watched_actions, () => true),
    videoPlays: sumAction(row.video_play_actions, () => true),
    msgCount,
    cpl: msgCount > 0 ? spend / msgCount : null
  };
}

// ---- 1) Resumo do mês (agregado, conta inteira) ----
const accountRows = await fetchAccountInsights(monthStartIso, todayIso, null);
const current = summarizeAccountRow(accountRows[0]) || summarizeAccountRow({});

// ---- 2) Série diária do mês (pro termômetro de gasto) ----
const dailyRows = await fetchAccountInsights(monthStartIso, todayIso, 1);
const dailySeries = dailyRows
  .map(row => ({ date: row.date_start, totalSpend: parseNum(row.spend) }))
  .sort((a, b) => a.date.localeCompare(b.date));

// ---- 3) Campanhas do mês (destaques + funil por etapa) ----
const campaignRows = await fetchCampaignInsights(monthStartIso, todayIso);
const campaigns = campaignRows.map(c => {
  const spend = parseNum(c.spend);
  const msgCount = sumAction(c.actions, isMessagingActionType);
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    spend,
    impressions: parseNum(c.impressions),
    clicks: parseNum(c.clicks),
    ctr: parseNum(c.ctr),
    results: msgCount,
    costPerResult: msgCount > 0 ? spend / msgCount : null
  };
}).filter(c => c.spend > 0);

// ---- 4) Funil Clint/AspektoApp (via comentário mais recente no ClickUp) ----
async function fetchClintMetrics() {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${CLINT_METRICS_TASK_ID}/comment`, {
    headers: { Authorization: CLICKUP_TOKEN }
  });
  if (!res.ok) throw new Error(`ClickUp comments -> ${res.status} ${await res.text()}`);
  const data = await res.json();
  const comments = data.comments || [];
  if (!comments.length) throw new Error('Nenhuma métrica publicada ainda.');
  const latest = comments.reduce((a, b) => (Number(b.date) > Number(a.date) ? b : a));
  return JSON.parse(String(latest.comment_text).trim());
}

let funnel = null;
let clintRaw = null;
try {
  clintRaw = await fetchClintMetrics();
  const periodMTD = clintRaw?.periods?.month_to_date;
  if (periodMTD) {
    const spend = current.spend;
    funnel = {
      spend,
      scheduled: periodMTD.scheduled,
      attended: periodMTD.attended,
      won: periodMTD.won,
      wonValue: periodMTD.wonValue,
      cplSchedule: periodMTD.scheduled > 0 ? spend / periodMTD.scheduled : null,
      cplAttend: periodMTD.attended > 0 ? spend / periodMTD.attended : null,
      cac: periodMTD.won > 0 ? spend / periodMTD.won : null,
      roas: spend > 0 ? periodMTD.wonValue / spend : null
    };
  }
} catch (e) {
  console.log('Funil Clint/AspektoApp indisponível:', e.message);
}

// ---- 5) Destaques de campanhas (mesma lógica do dashboard live) ----
function computeCampaignHighlights(camps) {
  const rows = camps.map(c => ({ name: c.name.replace(/^\[Lentes\]\s*/i, ''), spend: c.spend, results: c.results, ctr: c.ctr, costPerResult: c.costPerResult }));
  if (!rows.length) return null;
  const withResults = rows.filter(r => r.results > 0);
  const bestCost = withResults.length ? withResults.reduce((a, b) => (b.costPerResult < a.costPerResult ? b : a)) : null;
  const mostResults = withResults.length ? withResults.reduce((a, b) => (b.results > a.results ? b : a)) : null;
  const hottest = rows.reduce((a, b) => (b.ctr > a.ctr ? b : a));
  const noResultBigSpend = rows.filter(r => r.results === 0).sort((a, b) => b.spend - a.spend)[0] || null;
  const worstCost = withResults.length > 1 ? withResults.reduce((a, b) => (b.costPerResult > a.costPerResult ? b : a)) : null;
  const attention = (noResultBigSpend && noResultBigSpend.spend > 30) ? noResultBigSpend : (worstCost && worstCost !== bestCost ? worstCost : null);
  return { bestCost, mostResults, hottest, attention };
}
const highlights = computeCampaignHighlights(campaigns);

// ---- 6) Gasto por etapa de funil (Perfil/Topo/Meio/Fundo), mesma classificação do live ----
function classifyStage(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('topo')) return 'topo';
  if (n.includes('meio')) return 'meio';
  if (n.includes('fundo')) return 'fundo';
  return 'outros';
}
function classifyDestino(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('perfil')) return 'perfil';
  if (n.includes('whatsapp')) return 'whatsapp';
  return 'outro';
}
const funnelSpend = { perfil: 0, topo: 0, meio: 0, fundo: 0, outros: 0 };
for (const c of campaigns) {
  const stage = classifyStage(c.name);
  if (stage === 'topo') {
    funnelSpend[classifyDestino(c.name) === 'perfil' ? 'perfil' : 'topo'] += c.spend;
  } else {
    funnelSpend[stage] += c.spend;
  }
}

// ---- 7) Termômetro de leads (hoje vs ritmo do mês) ----
const leadToday = clintRaw?.periods?.today?.scheduled ?? null;

const out = {
  updatedAt: new Date().toISOString(),
  period: { since: monthStartIso, until: todayIso },
  current,
  dailySeries,
  campaigns,
  highlights,
  funnelSpendByStage: funnelSpend,
  funnel,
  leadToday,
  clintPeriodMTD: clintRaw?.periods?.month_to_date || null
};

const fs = await import('node:fs/promises');
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/report_data.json', JSON.stringify(out, null, 2));
console.log(`OK — relatório gravado em docs/report_data.json (gasto do mês: ${current.spend}, ${campaigns.length} campanhas)`);
