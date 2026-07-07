// HTML del panel "Administrador de Conexiones".
// Todo va inline (CSS/JS) para no depender de recursos locales: la CSP solo
// permite estilos inline y scripts con nonce.
export default function getConnectionManagerHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SFTP: Conexiones</title>
<style>
  body {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 0;
    margin: 0;
  }
  .layout {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100vh;
  }
  aside {
    background: var(--vscode-sideBar-background);
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  aside h3 {
    margin: 12px 12px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.8;
  }
  #workspaceRow { padding: 0 12px; }
  #workspaceRow select { width: 100%; }
  ul#connList { list-style: none; margin: 4px 0; padding: 0; }
  ul#connList li {
    padding: 6px 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ul#connList li:hover { background: var(--vscode-list-hoverBackground); }
  ul#connList li.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  ul#connList li .bullet { width: 14px; text-align: center; flex: none; }
  ul#connList li .badge {
    margin-left: auto;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    flex: none;
  }
  .sidebar-actions { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
  main { padding: 16px 24px; overflow-y: auto; }
  #banner {
    display: none;
    padding: 8px 12px;
    margin-bottom: 12px;
    border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
    background: var(--vscode-textBlockQuote-background);
  }
  #formTitle { margin: 0 0 12px; font-size: 16px; }
  .field { margin-bottom: 10px; max-width: 520px; }
  .field label { display: block; margin-bottom: 3px; opacity: 0.9; }
  .field .hint { display: block; margin-top: 2px; font-size: 11px; opacity: 0.6; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  input:focus, select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .checkbox-field { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .checkbox-field label { margin: 0; }
  .row2 { display: flex; gap: 12px; max-width: 520px; }
  .row2 .field { flex: 1; }
  .actions { margin-top: 18px; display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    padding: 5px 14px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    font-family: inherit;
    font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.35)); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-top: 14px; min-height: 18px; }
  #status.ok { color: var(--vscode-testing-iconPassed, #2ea043); }
  #status.err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  #status.busy { opacity: 0.8; }
  .dirty-dot { color: var(--vscode-editorWarning-foreground, #cca700); }
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div id="workspaceRow" style="display:none">
      <h3>Carpeta</h3>
      <select id="selWorkspace"></select>
    </div>
    <h3>Conexiones</h3>
    <ul id="connList"></ul>
    <div class="sidebar-actions">
      <button id="btnNew" class="secondary">+ Nueva conexión</button>
      <button id="btnOpenJson" class="secondary">Abrir sftp.json</button>
    </div>
  </aside>
  <main>
    <div id="banner"></div>
    <h2 id="formTitle"></h2>
    <div id="form">
      <div class="field">
        <label for="fName" id="lblName">Nombre</label>
        <input type="text" id="fName">
        <span class="hint" id="hintName"></span>
      </div>
      <div class="field">
        <label for="fProtocol">Protocolo</label>
        <select id="fProtocol"></select>
      </div>
      <div class="row2" id="rowServer">
        <div class="field" style="flex:3">
          <label for="fHost">Host</label>
          <input type="text" id="fHost">
        </div>
        <div class="field" style="flex:1">
          <label for="fPort">Puerto</label>
          <input type="number" id="fPort">
        </div>
      </div>
      <div class="field" id="rowUser">
        <label for="fUser">Usuario</label>
        <input type="text" id="fUser">
      </div>
      <div class="field" id="rowPassword">
        <label for="fPassword">Contraseña</label>
        <input type="password" id="fPassword">
        <span class="hint">Opcional. Si se deja vacía, se pedirá al conectar (y podrá guardarse de forma segura en VSCode).</span>
      </div>
      <div class="field sftp-only" id="rowPrivateKey">
        <label for="fPrivateKey">Clave privada (ruta)</label>
        <input type="text" id="fPrivateKey">
      </div>
      <div class="field sftp-only" id="rowPassphrase">
        <label for="fPassphrase">Passphrase</label>
        <input type="password" id="fPassphrase">
      </div>
      <div class="field">
        <label for="fRemotePath">Ruta remota</label>
        <input type="text" id="fRemotePath">
      </div>
      <div class="checkbox-field">
        <input type="checkbox" id="fUploadOnSave">
        <label for="fUploadOnSave">Subir al guardar (uploadOnSave)</label>
      </div>
      <div class="checkbox-field" id="rowDefaultProfile">
        <input type="checkbox" id="fDefaultProfile">
        <label for="fDefaultProfile">Perfil por defecto al abrir el proyecto</label>
      </div>
      <div class="actions">
        <button id="btnSave">Guardar</button>
        <button id="btnTest" class="secondary">Probar conexión</button>
        <button id="btnActivate" class="secondary">Activar</button>
        <button id="btnDuplicate" class="secondary">Duplicar</button>
        <button id="btnDelete" class="danger">Eliminar</button>
      </div>
      <div id="status"></div>
    </div>
  </main>
</div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var BASE_KEY = '__base__';

  var workspaces = [];
  var ws = null;
  var state = null;
  var selected = BASE_KEY;
  var dirty = false;
  var confirmingDelete = false;
  var statusTimer = null;

  var FIELDS = [
    { id: 'fHost', key: 'host' },
    { id: 'fPort', key: 'port', type: 'number' },
    { id: 'fUser', key: 'username' },
    { id: 'fPassword', key: 'password', secret: true },
    { id: 'fPrivateKey', key: 'privateKeyPath' },
    { id: 'fPassphrase', key: 'passphrase', secret: true },
    { id: 'fRemotePath', key: 'remotePath' }
  ];

  function $(id) { return document.getElementById(id); }
  function post(msg) { vscode.postMessage(msg); }
  function isBase() { return selected === BASE_KEY; }
  function current() { return isBase() ? state.base : state.profiles[selected]; }
  function profileNames() { return Object.keys(state.profiles || {}); }

  function markDirty() {
    dirty = true;
    renderListOnly();
    updateButtons();
  }

  function setStatus(text, kind) {
    var el = $('status');
    el.textContent = text || '';
    el.className = kind || '';
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (kind === 'ok') {
      statusTimer = setTimeout(function () { el.textContent = ''; el.className = ''; }, 4000);
    }
  }

  function resolvedProtocol(obj) {
    if (obj && obj.protocol) { return obj.protocol; }
    if (!isBase() && state.base.protocol) { return state.base.protocol; }
    return 'sftp';
  }

  // ---------- render ----------

  function renderWorkspaces() {
    var row = $('workspaceRow');
    var sel = $('selWorkspace');
    if (workspaces.length <= 1) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    sel.innerHTML = '';
    workspaces.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w.fsPath;
      opt.textContent = w.name;
      opt.selected = w.fsPath === ws;
      sel.appendChild(opt);
    });
  }

  function renderListOnly() {
    var list = $('connList');
    list.innerHTML = '';

    function addItem(key, label, bullet) {
      var li = document.createElement('li');
      li.setAttribute('data-key', key);
      if (key === selected) { li.className = 'selected'; }
      var b = document.createElement('span');
      b.className = 'bullet';
      b.textContent = bullet;
      li.appendChild(b);
      var t = document.createElement('span');
      t.textContent = label + (dirty && key === selected ? ' ' : '');
      li.appendChild(t);
      if (dirty && key === selected) {
        var d = document.createElement('span');
        d.className = 'dirty-dot';
        d.textContent = '●';
        li.appendChild(d);
      }
      if (key !== BASE_KEY && key === state.activeProfile) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'activa';
        li.appendChild(badge);
      }
      li.addEventListener('click', function () { select(key); });
      list.appendChild(li);
    }

    addItem(BASE_KEY, 'Configuración base', '⚙');
    profileNames().forEach(function (name) {
      addItem(name, name, name === state.activeProfile ? '●' : '○');
    });
  }

  function renderProtocolOptions(obj) {
    var sel = $('fProtocol');
    sel.innerHTML = '';
    var options = [];
    if (!isBase()) {
      options.push({ value: '', label: '(heredar: ' + (state.base.protocol || 'sftp') + ')' });
    }
    options.push({ value: 'sftp', label: 'sftp' });
    options.push({ value: 'ftp', label: 'ftp' });
    options.push({ value: 'local', label: 'local' });
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    if (isBase()) {
      sel.value = obj.protocol || 'sftp';
    } else {
      sel.value = obj.protocol || '';
    }
  }

  function renderForm() {
    if (!state) { return; }
    var obj = current();
    if (!obj) { selected = BASE_KEY; obj = state.base; }

    $('formTitle').textContent = isBase()
      ? 'Configuración base (compartida)'
      : 'Conexión: ' + selected;

    $('lblName').textContent = isBase() ? 'Nombre del proyecto' : 'Nombre de la conexión';
    $('fName').value = isBase() ? (obj.name || '') : selected;
    $('hintName').textContent = isBase()
      ? 'Solo informativo (campo "name" del sftp.json).'
      : 'Identifica este servidor: es la clave del perfil en sftp.json.';

    renderProtocolOptions(obj);

    FIELDS.forEach(function (f) {
      var input = $(f.id);
      var value = obj[f.key];
      input.value = value === undefined || value === null || value === true ? '' : String(value);
      var placeholder = '';
      if (!isBase() && state.base[f.key] !== undefined && state.base[f.key] !== null) {
        placeholder = f.secret ? '(heredada de la base)' : String(state.base[f.key]) + ' (heredado)';
      } else if (f.key === 'port') {
        placeholder = resolvedProtocol(obj) === 'ftp' ? '21' : '22';
      } else if (f.key === 'remotePath') {
        placeholder = '/';
      }
      input.placeholder = placeholder;
    });

    var uos = obj.uploadOnSave;
    if (uos === undefined && !isBase()) { uos = state.base.uploadOnSave; }
    $('fUploadOnSave').checked = !!uos;

    $('rowDefaultProfile').style.display = isBase() ? 'none' : 'flex';
    if (!isBase()) {
      $('fDefaultProfile').checked = state.base.defaultProfile === selected;
    }

    var protocol = resolvedProtocol(obj);
    var isLocal = protocol === 'local';
    $('rowServer').style.display = isLocal ? 'none' : 'flex';
    $('rowUser').style.display = isLocal ? 'none' : 'block';
    $('rowPassword').style.display = isLocal ? 'none' : 'block';
    var showSftp = protocol === 'sftp';
    $('rowPrivateKey').style.display = showSftp ? 'block' : 'none';
    $('rowPassphrase').style.display = showSftp ? 'block' : 'none';

    updateButtons();
  }

  function updateButtons() {
    $('btnActivate').style.display = isBase() ? 'none' : 'inline-block';
    $('btnDuplicate').style.display = isBase() ? 'none' : 'inline-block';
    $('btnDelete').style.display = isBase() ? 'none' : 'inline-block';
    $('btnActivate').disabled = selected === state.activeProfile;
    $('btnActivate').textContent = selected === state.activeProfile ? 'Activa' : 'Activar';
    if (!confirmingDelete) { $('btnDelete').textContent = 'Eliminar'; }
    $('btnSave').textContent = dirty ? 'Guardar ●' : 'Guardar';
  }

  function renderBanner() {
    var banner = $('banner');
    var messages = [];
    if (state && !state.exists) {
      messages.push('El archivo .vscode/sftp.json aún no existe: se creará al guardar.');
    }
    if (state && state.isArray) {
      messages.push('El sftp.json contiene varias configuraciones (array); este panel administra la primera.');
    }
    banner.textContent = messages.join(' ');
    banner.style.display = messages.length ? 'block' : 'none';
  }

  function renderAll() {
    renderWorkspaces();
    renderBanner();
    renderListOnly();
    renderForm();
  }

  function select(key) {
    confirmingDelete = false;
    selected = key;
    renderListOnly();
    renderForm();
  }

  // ---------- edición ----------

  function setField(obj, key, value, type) {
    if (type === 'number') {
      var n = parseInt(value, 10);
      if (isNaN(n)) { delete obj[key]; } else { obj[key] = n; }
    } else if (value === '') {
      delete obj[key];
    } else {
      obj[key] = value;
    }
    markDirty();
  }

  function uniqueName(baseName) {
    var name = baseName;
    var i = 2;
    while (state.profiles[name] !== undefined) {
      name = baseName + '-' + i;
      i++;
    }
    return name;
  }

  function renameProfile(oldName, rawNewName) {
    var newName = (rawNewName || '').trim();
    if (!newName || newName === oldName) { renderForm(); return; }
    if (state.profiles[newName] !== undefined) {
      setStatus('Ya existe una conexión llamada "' + newName + '".', 'err');
      renderForm();
      return;
    }
    state.profiles[newName] = state.profiles[oldName];
    delete state.profiles[oldName];
    if (state.base.defaultProfile === oldName) { state.base.defaultProfile = newName; }
    selected = newName;
    markDirty();
    renderAll();
  }

  // ---------- wiring ----------

  FIELDS.forEach(function (f) {
    $(f.id).addEventListener('input', function (e) {
      setField(current(), f.key, e.target.value, f.type);
    });
  });

  $('fName').addEventListener('change', function (e) {
    if (isBase()) { return; }
    renameProfile(selected, e.target.value);
  });
  $('fName').addEventListener('input', function (e) {
    if (!isBase()) { return; }
    setField(state.base, 'name', e.target.value);
  });

  $('fProtocol').addEventListener('change', function (e) {
    setField(current(), 'protocol', e.target.value);
    renderForm();
  });

  $('fUploadOnSave').addEventListener('change', function (e) {
    current().uploadOnSave = e.target.checked;
    markDirty();
  });

  $('fDefaultProfile').addEventListener('change', function (e) {
    if (e.target.checked) {
      state.base.defaultProfile = selected;
    } else if (state.base.defaultProfile === selected) {
      delete state.base.defaultProfile;
    }
    markDirty();
  });

  $('selWorkspace').addEventListener('change', function (e) {
    post({ type: 'load', workspace: e.target.value });
  });

  $('btnNew').addEventListener('click', function () {
    var name = uniqueName('servidor');
    state.profiles[name] = {};
    selected = name;
    markDirty();
    renderAll();
    $('fName').focus();
    $('fName').select();
  });

  $('btnDuplicate').addEventListener('click', function () {
    if (isBase()) { return; }
    var name = uniqueName(selected + '-copia');
    state.profiles[name] = JSON.parse(JSON.stringify(state.profiles[selected]));
    selected = name;
    markDirty();
    renderAll();
  });

  $('btnDelete').addEventListener('click', function () {
    if (isBase()) { return; }
    if (!confirmingDelete) {
      confirmingDelete = true;
      $('btnDelete').textContent = '¿Eliminar "' + selected + '"?';
      return;
    }
    confirmingDelete = false;
    delete state.profiles[selected];
    if (state.base.defaultProfile === selected) { delete state.base.defaultProfile; }
    selected = BASE_KEY;
    markDirty();
    renderAll();
    setStatus('Conexión eliminada. Recuerda guardar para aplicar el cambio.', 'ok');
  });

  $('btnSave').addEventListener('click', function () {
    setStatus('Guardando…', 'busy');
    post({ type: 'save', workspace: ws, base: state.base, profiles: state.profiles });
  });

  $('btnTest').addEventListener('click', function () {
    setStatus('Probando conexión… (si hace falta, VSCode pedirá la contraseña)', 'busy');
    post({
      type: 'test',
      workspace: ws,
      base: state.base,
      profiles: state.profiles,
      profile: isBase() ? null : selected
    });
  });

  $('btnActivate').addEventListener('click', function () {
    if (isBase()) { return; }
    post({ type: 'activate', workspace: ws, profile: selected });
  });

  $('btnOpenJson').addEventListener('click', function () {
    post({ type: 'openJson', workspace: ws });
  });

  // ---------- mensajes de la extensión ----------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'init':
        workspaces = msg.workspaces;
        ws = msg.workspace;
        state = msg.state;
        dirty = false;
        selected = state.activeProfile && state.profiles[state.activeProfile] !== undefined
          ? state.activeProfile
          : BASE_KEY;
        renderAll();
        break;
      case 'state':
        ws = msg.workspace;
        state = msg.state;
        dirty = false;
        if (selected !== BASE_KEY && state.profiles[selected] === undefined) {
          selected = BASE_KEY;
        }
        renderAll();
        break;
      case 'activeProfile':
        state.activeProfile = msg.profile;
        renderListOnly();
        updateButtons();
        setStatus(msg.profile ? 'Perfil "' + msg.profile + '" activado.' : 'Perfil desactivado.', 'ok');
        break;
      case 'saveResult':
        if (msg.ok) {
          setStatus('Guardado en .vscode/sftp.json ✓', 'ok');
        } else {
          setStatus('No se pudo guardar: ' + msg.error, 'err');
        }
        break;
      case 'testResult':
        if (msg.ok) {
          setStatus('Conexión correcta ✓' + (msg.target ? ' (' + msg.target + ')' : ''), 'ok');
        } else {
          setStatus('Falló la conexión' + (msg.target ? ' (' + msg.target + ')' : '') + ': ' + msg.error, 'err');
        }
        break;
      case 'stateError':
        setStatus('No se pudo leer sftp.json: ' + msg.error, 'err');
        break;
      case 'errorMsg':
        setStatus(msg.error, 'err');
        break;
    }
  });

  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
