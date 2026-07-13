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

const out = {
  updatedAt: new Date().toISOString(),
  members,
  tasks
};

const fs = await import('node:fs/promises');
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/data.json', JSON.stringify(out, null, 2));
console.log(`OK — ${tasks.length} tarefas gravadas em docs/data.json`);
