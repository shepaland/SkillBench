const COLUMNS = ["ID", "STATE", "PRIORITY", "TITLE"];
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

function byPriority(jobs) {
  return [...jobs].sort((left, right) => {
    const difference = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}

export function renderJob(job) {
  return [job.id, job.state, job.priority, job.title].join("  ");
}

export function renderJobList(unordered) {
  const jobs = byPriority(unordered);
  if (jobs.length === 0) {
    return "no jobs";
  }
  const rows = jobs.map((job) => [job.id, job.state, job.priority, job.title]);
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length)),
  );
  const lines = [COLUMNS, ...rows].map((row) => renderRow(row, widths));
  lines.push(jobs.length === 1 ? "1 job" : `${jobs.length} jobs`);
  return lines.join("\n");
}

export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

export function renderError(error) {
  return `queuedesk: ${error.message}`;
}

export function renderErrorJson(error) {
  return JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2);
}

function renderRow(cells, widths) {
  return cells
    .map((cell, index) => cell.padEnd(widths[index]))
    .join("  ")
    .trimEnd();
}
