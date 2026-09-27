import { $, esc, api } from '/common.js';
import { loadMyExams, saveMyExam } from '/profesor/store.js';

const toolsBox = $('#tools');
const tpl = $('#tool-row');

function addTool(name = '', url = '') {
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.querySelector('.t-name').value = name;
  row.querySelector('.t-url').value = url;
  row.querySelector('.t-del').addEventListener('click', () => row.remove());
  toolsBox.append(row);
  return row;
}
$('#add-tool').addEventListener('click', () => addTool().querySelector('.t-name').focus());
addTool();

// Lista de exámenes creados desde este navegador (el token del profesor sólo vive aquí).
const mine = loadMyExams();
if (mine.length) {
  $('#my-exams').hidden = false;
  $('#my-exams-list').innerHTML = mine
    .map((e) => `<li><a href="/profesor/panel.html?exam=${encodeURIComponent(e.id)}">${esc(e.name)}</a>
      <span class="muted small">código ${esc(e.code)}, ${new Date(e.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</span></li>`)
    .join('');
}

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#create-error');
  errEl.hidden = true;
  const tools = [...toolsBox.querySelectorAll('.tool-row')]
    .map((r) => ({ name: r.querySelector('.t-name').value.trim(), url: r.querySelector('.t-url').value.trim() }))
    .filter((t) => t.url);

  const btn = e.submitter; btn.disabled = true;
  try {
    const { exam, teacherToken } = await api('/api/exams', {
      method: 'POST',
      body: {
        name: $('#f-name').value,
        durationMin: Number($('#f-duration').value),
        mode: new FormData(e.target).get('mode'),
        tools,
        toleranceSec: Number($('#f-tolerance').value),
        alertText: $('#f-alert').value,
      },
    });
    saveMyExam({ id: exam.id, name: exam.name, code: exam.code, createdAt: exam.createdAt, token: teacherToken });
    location.href = `/profesor/panel.html?exam=${encodeURIComponent(exam.id)}`;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally { btn.disabled = false; }
});
