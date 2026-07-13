const TOKEN = process.env.CLICKUP_TOKEN;
const LIST_ID = '901327810989';
const TEAM_ID = '90133042352';

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

const [taskData, teamData] = await Promise.all([
  api(`/list/${LIST_ID}/task?include_closed=true`),
  api(`/team`)
]);

const team = (teamData.teams || []).find(t => t.id === TEAM_ID) || teamData.teams?.[0];
const members = (team?.members || []).map(m => ({
  id: m.user.id,
  name: m.user.username
}));

const tasks = (taskData.tasks || []).map(t => ({
  id: t.id,
  name: t.name,
  status: (t.status?.status || '').toLowerCase(),
  assignee: t.assignees && t.assignees[0] ? { id: t.assignees[0].id, name: t.assignees[0].username } : null,
  due_date: t.due_date ? Number(t.due_date) : null,
  date_closed: t.date_closed ? Number(t.date_closed) : null,
  url: t.url
}));

const timeByStatus = await fetchTimeInStatus(tasks.map(t => t.id));

const userStats = members.map(m => {
  const mine = tasks.filter(t => t.assignee && t.assignee.id === m.id);
  const done = mine.filter(t => t.status === 'concluído').length;
  return { id: m.id, name: m.name, done, open: mine.length - done };
});

const stageTimes = Object.fromEntries(
  Object.entries(timeByStatus).map(([status, s]) => [status, s.count ? Math.round(s.total / s.count) : null])
);

const out = {
  updatedAt: new Date().toISOString(),
  members,
  tasks,
  userStats,
  stageTimes
};

const fs = await import('node:fs/promises');
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/data.json', JSON.stringify(out, null, 2));
console.log(`OK — ${tasks.length} tarefas gravadas em docs/data.json`);
