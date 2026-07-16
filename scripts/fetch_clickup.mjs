const TOKEN = process.env.CLICKUP_TOKEN;
const LIST_ID = '901327810989';
const TEAM_ID = '90133042352';
const TIPO_FIELD_ID = '4db7b187-0bc2-4a77-888a-6a06423f04df';
const EXCLUDED_MEMBER_IDS = new Set([55109277]); // conta duplicada (Yuri Lima - e-mail pessoal, sem demandas)
const DONE_STATUSES = new Set(['concluído', 'banco de publicações']);

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
  url: t.url
}));

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
