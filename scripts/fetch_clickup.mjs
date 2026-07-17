const TOKEN = process.env.CLICKUP_TOKEN;
const LIST_ID = '901327810989';
const TEAM_ID = '90133042352';
const TIPO_FIELD_ID = '4db7b187-0bc2-4a77-888a-6a06423f04df';
const EMAIL_FIELD_ID = 'e33ce220-035a-4600-aead-7b3b88570eff';
const EXCLUDED_MEMBER_IDS = new Set([55109277]); // conta duplicada (Yuri Lima - e-mail pessoal, sem demandas)
const DONE_STATUSES = new Set(['concluído', 'banco de publicações']);
const MOVE_QUEUE_URL = 'https://script.google.com/macros/s/AKfycbwT5j1BjTfgneljYlnjVS_4bRiBqvoHw2Qcs5yPNErQw-2AZ_TOkj2CX9hoPyKZpmQt/exec';
const ALLOWED_STATUSES = new Set([
  'fila de demandas', 'criação de copy / roteiros', 'captação / gravação',
  'produção / edição', 'aprovação 1', 'ajuste', 'aprovação 2',
  'banco de publicações', 'concluído', 'impedimento'
]);
const ALLOWED_ASSIGNEE_IDS = new Set([118016784, 118016783, 118016782, 278685306]);

if (!TOKEN) {
  console.error('CLICKUP_TOKEN não definido (configure o secret CLICKUP_API_TOKEN no repositório).');
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    headers: { Authorization: TOKEN }
  });
  if (!res.ok) {
    throw new Error(`ClickUp API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function processMoveQueue() {
  let pending = [];
  try {
    const res = await fetch(`${MOVE_QUEUE_URL}?action=pending`);
    if (!res.ok) { console.log('Fila de movimentação: HTTP', res.status); return; }
    const data = await res.json();
    pending = data.pending || [];
  } catch (e) {
    console.log('Fila de movimentação indisponível:', e.message);
    return;
  }

  for (const item of pending) {
    try {
      const action = item.action || 'status'; // compat com itens antigos sem 'action'
      const value = item.action ? item.value : item.new_status;
      const task = await api(`/task/${item.task_id}`);

      if (!task.list || String(task.list.id) !== LIST_ID) {
        console.log(`Ignorado ${item.task_id}: não pertence à lista de demandas`);
      } else {
        let body = null;
        if (action === 'status' && ALLOWED_STATUSES.has(String(value))) {
          body = { status: value };
        } else if (action === 'assignee' && ALLOWED_ASSIGNEE_IDS.has(Number(value))) {
          const currentIds = (task.assignees || []).map(a => a.id);
          body = { assignees: { add: [Number(value)], rem: currentIds.filter(id => id !== Number(value)) } };
        } else if (action === 'due_date' && value) {
          const ms = new Date(value).getTime();
          if (!isNaN(ms)) body = { due_date: ms, due_date_time: false };
        }

        if (body) {
          await fetch(`https://api.clickup.com/api/v2/task/${item.task_id}`, {
            method: 'PUT',
            headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          console.log(`Aplicado ${action}=${value} em ${item.task_id} (${item.task_name || ''})`);
        } else {
          console.log(`Ignorado ${item.task_id}: ${action}=${value} inválido`);
        }
      }
    } catch (e) {
      console.log(`Erro ao processar ${item.task_id}:`, e.message);
    }
    try {
      await fetch(`${MOVE_QUEUE_URL}?action=ack&id=${encodeURIComponent(item.id)}`);
    } catch (e) {
      console.log(`Erro ao confirmar processamento de ${item.id}:`, e.message);
    }
  }
}

await processMoveQueue();

async function fetchTimeInStatus(taskIds) {
  const acc = {};
  for (let i = 0; i < taskIds.length; i += 100) {
    const chunk = taskIds.slice(i, i + 100);
    const qs = chunk.map(id => `task_ids[]=${encodeURIComponent(id)}`).join('&');
    let raw;
    try {
      raw = await api(`/task/bulk_time_in_status/task_ids?${qs}`);
    } catch (e) {
      console.log('Time in Status indisponível (ClickApp provavelmente desativado):', e.message);
      return {};
    }
    const map = raw.tasks || raw;
    for (const taskId in map) {
      const t = map[taskId];
      const entries = [].concat(t.status_history || [], t.current_status ? [t.current_status] : []);
      for (const e of entries) {
        const label = (e.status || '').toLowerCase().trim();
        const minutes = Number((e.total_time && e.total_time.by_minute) || 0);
        if (!label || !minutes) continue;
        if (!acc[label]) acc[label] = { total: 0, count: 0 };
        acc[label].total += minutes;
        acc[label].count += 1;
      }
    }
  }
  return acc;
}

function getTipo(t) {
  const field = (t.custom_fields || []).find(f => f.id === TIPO_FIELD_ID);
  if (!field || field.value === undefined || field.value === null) return null;
  const options = (field.type_config && field.type_config.options) || [];
  const opt = options.find(o => o.orderindex === field.value) || options[field.value];
  return opt ? opt.name : null;
}

function getEmail(t) {
  const field = (t.custom_fields || []).find(f => f.id === EMAIL_FIELD_ID);
  if (!field || field.value === undefined || field.value === null || field.value === '') return null;
  return field.value;
}

async function fetchTaskExtras(taskIds) {
  const extras = {};
  for (const id of taskIds) {
    try {
      const t = await api(`/task/${id}?include_subtasks=true`);
      extras[id] = {
        description: t.markdown_description || t.text_content || t.description || '',
        priority: t.priority || null,
        start_date: t.start_date ? Number(t.start_date) : null,
        subtasks: (t.subtasks || []).map(s => ({
          id: s.id,
          name: s.name,
          status: (s.status && s.status.status || '').toLowerCase(),
          assignee: s.assignees && s.assignees[0] ? { name: s.assignees[0].username } : null
        }))
      };
    } catch (e) {
      extras[id] = { description: '', priority: null, start_date: null, subtasks: [] };
    }
  }
  return extras;
}

const [taskData, teamData] = await Promise.all([
  api(`/list/${LIST_ID}/task?include_closed=true`),
  api(`/team`)
]);

const team = (teamData.teams || []).find(t => t.id === TEAM_ID) || teamData.teams?.[0];
const members = (team?.members || [])
  .map(m => ({ id: m.user.id, name: m.user.username }))
  .filter(m => !EXCLUDED_MEMBER_IDS.has(Number(m.id)));

const tasks = (taskData.tasks || []).map(t => ({
  id: t.id,
  name: t.name,
  status: (t.status?.status || '').toLowerCase(),
  assignee: t.assignees && t.assignees[0] ? { id: t.assignees[0].id, name: t.assignees[0].username } : null,
  due_date: t.due_date ? Number(t.due_date) : null,
  date_created: t.date_created ? Number(t.date_created) : null,
  date_closed: t.date_closed ? Number(t.date_closed) : null,
  tipo: getTipo(t),
  email: getEmail(t),
  url: t.url
}));

const taskExtras = await fetchTaskExtras(tasks.map(t => t.id));
for (const t of tasks) {
  const ex = taskExtras[t.id] || {};
  t.description = ex.description || '';
  t.priority = ex.priority || null;
  t.start_date = ex.start_date || null;
  t.subtasks = ex.subtasks || [];
}

const timeByStatus = await fetchTimeInStatus(tasks.map(t => t.id));

const userStats = members.map(m => {
  const mine = tasks.filter(t => t.assignee && t.assignee.id === m.id);
  const done = mine.filter(t => DONE_STATUSES.has(t.status)).length;
  return { id: m.id, name: m.name, done, open: mine.length - done };
});

const stageTimes = Object.fromEntries(
  Object.entries(timeByStatus).map(([status, s]) => [status, s.count ? Math.round(s.total / s.count) : null])
);

const tasksByType = {};
for (const t of tasks) {
  const key = t.tipo || 'Sem tipo';
  tasksByType[key] = (tasksByType[key] || 0) + 1;
}

const completionByType = {};
for (const t of tasks) {
  if (!t.date_closed || !t.date_created) continue;
  const key = t.tipo || 'Sem tipo';
  const minutes = (t.date_closed - t.date_created) / 60000;
  if (!completionByType[key]) completionByType[key] = { total: 0, count: 0 };
  completionByType[key].total += minutes;
  completionByType[key].count += 1;
}
const avgCompletionTimeByType = Object.fromEntries(
  Object.entries(completionByType).map(([tipo, s]) => [tipo, s.count ? Math.round(s.total / s.count) : null])
);

const onTimeRateByUser = members.map(m => {
  const finished = tasks.filter(t => t.assignee && t.assignee.id === m.id && t.date_closed && t.due_date);
  const onTime = finished.filter(t => t.date_closed <= t.due_date).length;
  return {
    id: m.id,
    name: m.name,
    total: finished.length,
    onTime,
    rate: finished.length ? Math.round((onTime / finished.length) * 100) : null
  };
});

const monthlyVolume = (() => {
  const counts = {};
  for (const t of tasks) {
    if (!t.date_created) continue;
    const d = new Date(t.date_created);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, count]) => ({ month, count }));
})();

const out = {
  updatedAt: new Date().toISOString(),
  members,
  tasks,
  userStats,
  stageTimes,
  tasksByType,
  avgCompletionTimeByType,
  onTimeRateByUser,
  monthlyVolume
};

const fs = await import('node:fs/promises');
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/data.json', JSON.stringify(out, null, 2));
console.log(`OK — ${tasks.length} tarefas gravadas em docs/data.json`);
