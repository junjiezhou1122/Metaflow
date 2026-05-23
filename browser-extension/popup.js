const $ = (id) => document.getElementById(id);

async function send(message) {
  return await chrome.runtime.sendMessage(message);
}

async function refresh() {
  const res = await send({ type: "get-current-status" });
  const tab = res.tab || {};
  const state = res.state || {};
  const settings = res.settings || {};
  $("status").innerHTML = `
    <b>${escapeHtml(tab.title || "No active tab")}</b><br>
    <span class="muted">${escapeHtml(tab.url || "")}</span><br><br>
    visit: ${escapeHtml(state.visit_id || "-")}<br>
    dwell: ${state.dwell_seconds ?? 0}s · snapshots: ${state.snapshot_count ?? 0} · visit recorded: ${state.visitRecorded ? "yes" : "no"}
  `;
  $("captureStream").checked = Boolean(settings.captureStream);
  $("snapshotOnVisit").checked = Boolean(settings.snapshotOnVisit);
  $("heartbeatSeconds").value = settings.heartbeatSeconds ?? 15;
  $("endpoint").value = settings.endpoint ?? "http://localhost:3111/context/ingest";
}

$("save").addEventListener("click", async () => {
  $("result").textContent = "Saving full snapshot…";
  const res = await send({ type: "save-current-page", reason: $("saveReason").value.trim() || undefined });
  $("result").textContent = JSON.stringify(res, null, 2);
  await refresh();
});

$("refresh").addEventListener("click", refresh);

$("saveSettings").addEventListener("click", async () => {
  const settings = {
    captureStream: $("captureStream").checked,
    snapshotOnVisit: $("snapshotOnVisit").checked,
    heartbeatSeconds: Number($("heartbeatSeconds").value || 15),
    endpoint: $("endpoint").value,
  };
  const res = await send({ type: "update-settings", settings });
  $("result").textContent = JSON.stringify(res, null, 2);
  await refresh();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

refresh();
