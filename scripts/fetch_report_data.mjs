// Busca dados do Relatório (Meta Ads + funil Clint/AspektoApp) e grava docs/report_data.json,
// pro dashboard público (docs/index.html) conseguir montar a aba "Relatório" com a mesma
// profundidade do dashboard live do Cowork: comparação com mês anterior, evolução diária,
// vídeo/engajamento, eficiência de entrega, destaques de campanha, funil por etapa,
// termômetros e funil completo (Meta Ads -> AspektoApp).
//
// Precisa de dois secrets no GitHub Actions:
//   META_ADS_ACCESS_TOKEN — token de acesso Meta com permissão de leitura de Insights (ads_read)
//                            na conta de anúncios abaixo.
//   CLICKUP_TOKEN         — já existente (mesmo usado no fetch_clickup.mjs).

const META_TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const AD_ACCOUNT_ID = 'act_898197595348538'; // conta "Kico" — Clínica Aspekto - BH (Meta Ads)
const META_API_VERSION = 'v25.0';
const CLINT_METRICS_TASK_ID = '86ajmg6cz';

if (!META_TOKEN) {
  console.error('META_ADS_ACCESS_TOKEN não definido — configure esse secret no repositório (Settings > Secrets and variables > Actions).');
  process.exit(1);
}
if (!CLICKUP_TOKEN) {
  console.error('CLICKUP_TOKEN não definido.');
  process.exit(1);
}

// ---- Datas (horário de Brasília, UTC-3) ----
function brDateParts(d) {
  const utcMs = d.getTime() - 3 * 3600 * 1000;
  const br = new Date(utcMs);
  return { y: br.getUTCFullYear(), m: br.getUTCMonth(), day: br.getUTCDate() };
}
function isoDate(y, m, day) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function toUTCDate(y, m, day) { return new Date(Date.UTC(y, m, day)); }
function fromUTCDate(d) { return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() }; }
function ymdToIso(ymd) { return isoDate(ymd.y, ymd.m, ymd.day); }
function fmtShortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

const now = new Date();
const { y: curY, m: curM, day: curDay } = brDateParts(now);
const monthStartIso = isoDate(curY, curM, 1);
const todayIso = isoDate(curY, curM, curDay);

// Comparação justa: mês atual até ontem vs os mesmos N dias no início do mês anterior —
// evita comparar um mês parcial com um mês inteiro, o que distorceria as variações %.
const monthStartDate = toUTCDate(curY, curM, 1);
let curUntilDate = toUTCDate(curY, curM, curDay);
curUntilDate.setUTCDate(curUntilDate.getUTCDate() - 1);
if (curUntilDate < monthStartDate) curUntilDate = new Date(monthStartDate);
const curSinceIso = monthStartIso;
const curUntilIso = ymdToIso(fromUTCDate(curUntilDate));
const daysElapsed = Math.max(1, Math.round((curUntilDate - monthStartDate) / 86400000) + 1);

const prevSinceDate = toUTCDate(curY, curM - 1, 1);
const prevUntilDate = new Date(prevSinceDate);
prevUntilDate.setUTCDate(prevUntilDate.getUTCDate() + daysElapsed - 1);
const prevSinceIso = ymdToIso(fromUTCDate(prevSinceDate));
const prevUntilIso = ymdToIso(fromUTCDate(prevUntilDate));

// ---- Meta Graph API ----
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

const ACCOUNT_FIELDS = 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,post_engagement,actions,video_p25_watched_actions,video_p50_watched_actions,video_p95_watched_actions,video_play_actions';
const CAMPAIGN_FIELDS = 'campaign_id,campaign_name,spend,impressions,clicks,cpc,cpm,ctr,actions';

async function fetchAccountInsights(since, until) {
  const res = await metaApi(`/${AD_ACCOUNT_ID}/insights`, {
    fields: ACCOUNT_FIELDS, level: 'account', time_range: { since, until }, limit: 1
  });
  return (res.data || [])[0] || null;
}
async function fetchCampaignInsights(since, until) {
  const res = await metaApi(`/${AD_ACCOUNT_ID}/insights`, {
    fields: CAMPAIGN_FIELDS, level: 'campaign', time_range: { since, until }, limit: 200
  });
  return res.data || [];
}
async function fetchDailyCampaignInsights(since, until) {
  const res = await metaApi(`/${AD_ACCOUNT_ID}/insights`, {
    fields: CAMPAIGN_FIELDS, level: 'campaign', time_range: { since, until }, time_increment: '1', limit: 500
  });
  return res.data || [];
}

function summarizeAccount(row) {
  if (!row) return { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, reach: 0, frequency: 0, postEngagement: 0, videoP25: 0, videoP50: 0, videoP95: 0, videoPlays: 0, msgCount: 0, cpl: null };
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
    postEngagement: parseNum(row.post_engagement),
    videoP25: sumAction(row.video_p25_watched_actions, () => true),
    videoP50: sumAction(row.video_p50_watched_actions, () => true),
    videoP95: sumAction(row.video_p95_watched_actions, () => true),
    videoPlays: sumAction(row.video_play_actions, () => true),
    msgCount,
    cpl: msgCount > 0 ? spend / msgCount : null
  };
}

function mapCampaigns(rows) {
  return rows.map(c => {
    const spend = parseNum(c.spend);
    const msgCount = sumAction(c.actions, isMessagingActionType);
    return {
      id: c.campaign_id,
      name: c.campaign_name,
      spend,
      impressions: parseNum(c.impressions),
      clicks: parseNum(c.clicks),
      ctr: parseNum(c.ctr),
      results: msgCount,
      costPerResult: msgCount > 0 ? spend / msgCount : null
    };
  }).filter(c => c.spend > 0);
}

// ---- 1) Série diária do mês (evolução diária + termômetro de gasto) ----
const dailyRows = await fetchDailyCampaignInsights(monthStartIso, todayIso);
const byDate = {};
for (const row of dailyRows) {
  const dateIso = row.date_start;
  if (!dateIso) continue;
  if (!byDate[dateIso]) byDate[dateIso] = { date: dateIso, label: fmtShortDate(dateIso), totalSpend: 0, msgSpend: 0, msgCount: 0, impressions: 0, clicks: 0 };
  const spend = parseNum(row.spend);
  byDate[dateIso].totalSpend += spend;
  byDate[dateIso].impressions += parseNum(row.impressions);
  byDate[dateIso].clicks += parseNum(row.clicks);
  const msgCount = sumAction(row.actions, isMessagingActionType);
  if (msgCount > 0) {
    byDate[dateIso].msgSpend += spend;
    byDate[dateIso].msgCount += msgCount;
  }
}
const dailySeries = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

// ---- 2) Mês atual (até ontem) vs mesmo período do mês anterior ----
const [curAcctRow, curCampRows, prevAcctRow, prevCampRows] = await Promise.all([
  fetchAccountInsights(curSinceIso, curUntilIso),
  fetchCampaignInsights(curSinceIso, curUntilIso),
  fetchAccountInsights(prevSinceIso, prevUntilIso),
  fetchCampaignInsights(prevSinceIso, prevUntilIso)
]);
const current = summarizeAccount(curAcctRow);
const previous = summarizeAccount(prevAcctRow);
const campaigns = mapCampaigns(curCampRows);
void prevCampRows; // só precisamos do agregado da conta pro comparativo — campanhas do mês anterior não são exibidas

// ---- 3) Gasto do mês inteiro até hoje (pro funil completo — CPL/CAC/ROAS) ----
const fullMtdAcctRow = await fetchAccountInsights(monthStartIso, todayIso);
const spendFullMTD = parseNum(fullMtdAcctRow?.spend);

// ---- 4) Destaques de campanhas (mesma lógica do dashboard live) ----
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

// ---- 5) Gasto por etapa de funil (Perfil/Topo/Meio/Fundo), mesma classificação do live ----
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

// ---- 6) Funil Clint/AspektoApp (via comentário mais recente no ClickUp) ----
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
let clintPeriodMTD = null;
let leadToday = null;
try {
  const clintRaw = await fetchClintMetrics();
  clintPeriodMTD = clintRaw?.periods?.month_to_date || null;
  leadToday = clintRaw?.periods?.today?.scheduled ?? null;
  if (clintPeriodMTD) {
    funnel = {
      spend: spendFullMTD,
      scheduled: clintPeriodMTD.scheduled,
      attended: clintPeriodMTD.attended,
      won: clintPeriodMTD.won,
      wonValue: clintPeriodMTD.wonValue,
      cplSchedule: clintPeriodMTD.scheduled > 0 ? spendFullMTD / clintPeriodMTD.scheduled : null,
      cplAttend: clintPeriodMTD.attended > 0 ? spendFullMTD / clintPeriodMTD.attended : null,
      cac: clintPeriodMTD.won > 0 ? spendFullMTD / clintPeriodMTD.won : null,
      roas: spendFullMTD > 0 ? clintPeriodMTD.wonValue / spendFullMTD : null
    };
  }
} catch (e) {
  console.log('Funil Clint/AspektoApp indisponível:', e.message);
}

// ---- Grava o JSON estático consumido pelo docs/index.html ----
const out = {
  updatedAt: new Date().toISOString(),
  period: { since: curSinceIso, until: curUntilIso },
  previousPeriod: { since: prevSinceIso, until: prevUntilIso },
  dailySeries,
  current,
  previous,
  campaigns,
  funnelSpendByStage: funnelSpend,
  highlights,
  funnel,
  clintPeriodMTD,
  leadToday
};

const fs = await import('node:fs/promises');
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/report_data.json', JSON.stringify(out, null, 2));
console.log(`OK — relatório gravado em docs/report_data.json (gasto do período: ${current.spend.toFixed(2)}, ${campaigns.length} campanhas, gasto MTD p/ funil: ${spendFullMTD.toFixed(2)})`);
