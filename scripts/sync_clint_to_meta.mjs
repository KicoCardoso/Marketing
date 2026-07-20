import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ===================== Configuração =====================
const CLINT_TOKEN = process.env.CLINT_API_TOKEN;
const META_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const META_DATASET_ID = process.env.META_DATASET_ID || '1602726657764120'; // dataset "(Make) (Conversion API) (2025/Outubro)" já existente na conta
const META_API_VERSION = 'v25.0';

const CLINT_BASE = 'https://api.clint.digital';

// Funil "SDR - Comercial Aspekto": jornada do lead até agendar e comparecer na avaliação
const SDR_ORIGIN_ID = 'db8f3e6b-82aa-4a5a-b0d4-067bb72022e2';
const STAGE_AVALIACAO_AGENDADA = '9c5319f2-be89-4b85-8618-4e8242a953da'; // -> evento "Schedule"
const STAGE_COMPARECEU = 'cdb5f0e5-1042-4991-9ba5-48b53b264e96';         // -> evento custom "Compareceu"

// Funil "Realizada - Closer": onde a venda de fato fecha (status WON)
const CLOSER_ORIGIN_ID = '3eabab75-2aae-45ac-918c-017066f5cb86';         // -> evento "Purchase" (com valor)

const STATE_FILE = path.join(process.cwd(), 'docs', 'clint_sync_state.json');
const OVERLAP_MS = 3 * 60 * 60 * 1000; // sobreposição de 3h entre execuções, pra não perder nada por atraso/erro
const SENT_EVENT_RETENTION_DAYS = 60;
const MAX_PAGES = 25; // trava de segurança (25 páginas x 200 = até 5000 negócios por execução)

if (!CLINT_TOKEN) {
  console.error('CLINT_API_TOKEN não definido (configure o secret CLINT_API_TOKEN no repositório).');
  process.exit(1);
}
const dryRun = !META_TOKEN;
if (dryRun) {
  console.warn('META_CAPI_ACCESS_TOKEN não definido — rodando em modo leitura: vou mostrar o que seria enviado, mas não vou enviar nada ao Meta nem avançar o estado.');
}

// ===================== Clint API =====================
async function clintApi(pathname, params) {
  const url = new URL(CLINT_BASE + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { 'api-token': CLINT_TOKEN, Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Clint API ${pathname} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllDeals(params) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const data = await clintApi('/v1/deals', { ...params, page, limit: 200 });
    all.push(...(data.data || []));
    if (!data.hasNext) break;
    page += 1;
  }
  return all;
}

// ===================== Meta Conversions API =====================
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function normalizePhone(contact) {
  if (!contact || !contact.phone) return null;
  const digits = String((contact.ddi || '') + contact.phone).replace(/\D/g, '');
  return digits || null;
}

function normalizeEmail(contact) {
  if (!contact || !contact.email) return null;
  const email = String(contact.email).trim().toLowerCase();
  return email || null;
}

function buildUserData(contact) {
  const ud = {};
  const phone = normalizePhone(contact);
  if (phone) ud.ph = [sha256Hex(phone)];
  const email = normalizeEmail(contact);
  if (email) ud.em = [sha256Hex(email)];
  return ud;
}

async function sendMetaEvent({ eventName, eventTimeMs, contact, eventId, customData }) {
  const userData = buildUserData(contact);
  if (!userData.ph && !userData.em) {
    console.warn(`[pulado] ${eventName} (${eventId}): negócio sem telefone nem e-mail pra casar com o Meta.`);
    return { skipped: true };
  }
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(eventTimeMs / 1000),
      action_source: 'system_generated',
      event_id: eventId,
      user_data: userData,
      ...(customData ? { custom_data: customData } : {})
    }],
    access_token: META_TOKEN
  };
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${META_DATASET_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Meta CAPI ${eventName} (${eventId}) -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// ===================== Estado (dedupe + checkpoint) =====================
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastRunAt: null, sentEventIds: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pruneOldSentEvents(state) {
  const cutoff = Date.now() - SENT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.sentEventIds)) {
    if (new Date(ts).getTime() < cutoff) delete state.sentEventIds[id];
  }
}

// ===================== Orquestração =====================
async function handleEvent(eventName, deal, timeIso, eventId, customData, state, results) {
  if (state.sentEventIds[eventId]) return; // já processado numa execução anterior
  if (dryRun) {
    console.log(`[dry-run] enviaria "${eventName}" para negócio ${deal.id} (${deal.contact?.name || 's/nome'})`);
    return;
  }
  try {
    const time = timeIso ? new Date(timeIso).getTime() : Date.now();
    await sendMetaEvent({ eventName, eventTimeMs: time, contact: deal.contact, eventId, customData });
    state.sentEventIds[eventId] = new Date().toISOString();
    results[eventName] = (results[eventName] || 0) + 1;
  } catch (e) {
    console.error(`Erro ao enviar ${eventName} (negócio ${deal.id}): ${e.message}`);
    results.errors += 1;
  }
}

async function main() {
  const state = loadState();
  const now = new Date();
  const sinceDate = state.lastRunAt
    ? new Date(new Date(state.lastRunAt).getTime() - OVERLAP_MS)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000); // primeira execução: olha só as últimas 24h
  const sinceIso = sinceDate.toISOString();

  const results = { Schedule: 0, Compareceu: 0, Purchase: 0, errors: 0 };

  // 1) Funil SDR: agendamento e comparecimento na avaliação
  const sdrDeals = await fetchAllDeals({ origin_id: SDR_ORIGIN_ID, updated_stage_at_start: sinceIso });
  for (const deal of sdrDeals) {
    if (deal.stage_id === STAGE_AVALIACAO_AGENDADA) {
      await handleEvent('Schedule', deal, deal.updated_stage_at, `${deal.id}-schedule`, null, state, results);
    } else if (deal.stage_id === STAGE_COMPARECEU) {
      await handleEvent('Compareceu', deal, deal.updated_stage_at, `${deal.id}-compareceu`, null, state, results);
    }
  }

  // 2) Funil Closer: vendas fechadas (status WON)
  const wonDeals = await fetchAllDeals({ origin_id: CLOSER_ORIGIN_ID, status: 'WON', won_at_start: sinceIso });
  for (const deal of wonDeals) {
    const customData = { currency: deal.currency || 'BRL', value: Number(deal.value) || 0 };
    await handleEvent('Purchase', deal, deal.won_at, `${deal.id}-purchase`, customData, state, results);
  }

  console.log(`Concluído (desde ${sinceIso}): ${JSON.stringify(results)}`);

  if (!dryRun) {
    state.lastRunAt = now.toISOString();
    pruneOldSentEvents(state);
    saveState(state);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
