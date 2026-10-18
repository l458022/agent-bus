/**
 * dsh-plugin-agent-bus · client 半边
 *
 * 左侧栏一个「群组」入口（sidebar.panellist），中间栏一个群聊面板（main）。
 * 数据全部来自 host 的 /api/agent-bus/{snapshot,thread,say} —— 不自己存任何东西。
 *
 * 交互模型是微信群：上面选群，中间看记录，底下说一句。说完之后 host 会去后台
 * 唤醒群成员的 headless agent，它们各自 recv → send，回话自己出现在时间线上。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-bus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var PANEL_ID = 'agent-bus';
    var API = '/api/agent-bus';
    var POLL_MS = 3000;
    var THREAD_MS = 2500;
    /** 面板自己代表谁说话。和 host 的 config.peer 一致。 */
    var ME = 'dsh';

    var PHASE_COLOR = {
      working: '#3b82f6',
      idle: '#9ca3af',
      blocked: '#ef4444',
      delivering: '#22c55e',
      unknown: '#4b5563',
    };

    function phaseLabel(phase) {
      if (phase === 'working') return '在干';
      if (phase === 'idle') return '空闲';
      if (phase === 'blocked') return '卡住';
      if (phase === 'delivering') return '交付';
      return phase || '—';
    }

    function hhmm(iso) {
      if (!iso) return '';
      var m = String(iso).match(/T(\d{2}:\d{2})/);
      if (m) return m[1];
      var m2 = String(iso).match(/(\d{2}):(\d{2})/);
      return m2 ? m2[1] + ':' + m2[2] : '';
    }

    function useSnapshot() {
      var [state, setState] = React.useState({ loading: true, data: null, error: null });
      var [nonce, setNonce] = React.useState(0);

      React.useEffect(
        function () {
          var alive = true;
          function tick() {
            fetch(API + '/snapshot', { headers: { accept: 'application/json' } })
              .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
              })
              .then(function (data) {
                if (alive) setState({ loading: false, data: data, error: null });
              })
              .catch(function (err) {
                if (!alive) return;
                setState(function (prev) {
                  return { loading: false, data: prev.data, error: String((err && err.message) || err) };
                });
              });
          }
          tick();
          var timer = setInterval(tick, POLL_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [nonce],
      );

      return [
        state,
        function () {
          setNonce(function (n) {
            return n + 1;
          });
        },
      ];
    }

    /** 某个群的聊天记录。group 为空时不发请求。 */
    function useThread(group) {
      var [data, setData] = React.useState(null);
      React.useEffect(
        function () {
          if (!group) {
            setData(null);
            return undefined;
          }
          var alive = true;
          function tick() {
            fetch(API + '/thread?group=' + encodeURIComponent(group), { headers: { accept: 'application/json' } })
              .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
              })
              .then(function (json) {
                if (alive) setData(json);
              })
              .catch(function () {
                /* 轮询失败就等下一轮，不打断正在打字的人 */
              });
          }
          tick();
          var timer = setInterval(tick, THREAD_MS);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [group],
      );
      return data;
    }

    function getJson(path) {
      return fetch(API + path).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status);
          return json;
        });
      });
    }

    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status);
          return json;
        });
      });
    }

    function Icon() {
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', style: { width: 18, height: 18, display: 'block' }, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 },
        React.createElement('circle', { cx: 6, cy: 7, r: 2.3 }),
        React.createElement('circle', { cx: 18, cy: 7, r: 2.3 }),
        React.createElement('circle', { cx: 12, cy: 17.2, r: 2.3 }),
        React.createElement('path', { d: 'M7.9 8.5 11 15M16.1 8.5 13 15M8.3 7h7.4' }),
      );
    }

    var S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 13,
        lineHeight: 1.55,
      },
      head: { padding: '14px 18px 10px', borderBottom: '1px solid rgba(128,128,128,.2)', flex: '0 0 auto' },
      title: { display: 'flex', alignItems: 'center', gap: 8 },
      h1: { fontSize: 15, fontWeight: 600, margin: 0 },
      sub: { opacity: 0.55, fontSize: 12 },
      groups: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' },
      gtab: {
        border: '1px solid rgba(128,128,128,.32)',
        borderRadius: 99,
        padding: '3px 11px',
        fontSize: 12,
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      gtabOn: { background: 'rgba(59,130,246,.16)', borderColor: 'rgba(59,130,246,.55)', fontWeight: 600 },
      members: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9, alignItems: 'center' },
      chip: {
        border: '1px solid rgba(128,128,128,.32)',
        borderRadius: 99,
        padding: '1px 9px',
        fontSize: 11,
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      },
      addChip: { borderStyle: 'dashed', opacity: 0.75 },
      chipOn: { background: 'rgba(59,130,246,.18)', borderColor: 'rgba(59,130,246,.55)' },
      dot: { width: 6, height: 6, borderRadius: 99, flex: '0 0 auto' },
      hint: { opacity: 0.45, fontSize: 11 },
      list: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 },
      msg: { display: 'flex', flexDirection: 'column', maxWidth: '76%' },
      msgMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
      msgMeta: { fontSize: 11, opacity: 0.5, marginBottom: 3, display: 'flex', gap: 6 },
      bubble: {
        border: '1px solid rgba(128,128,128,.26)',
        borderRadius: 12,
        padding: '8px 12px',
        background: 'rgba(128,128,128,.07)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      bubbleMine: { background: 'rgba(59,130,246,.14)', borderColor: 'rgba(59,130,246,.4)' },
      subject: { fontSize: 11, opacity: 0.6, marginBottom: 3 },
      // 右侧留 120px：DSH 的浮动停靠面板（dsh-purge 的 .rt-dock，position:fixed）默认
      // 贴在右上角，而且能拖动；发送按钮贴着右边缘就会被它压住。留一段空白让两者不打架。
      composer: { flex: '0 0 auto', borderTop: '1px solid rgba(128,128,128,.2)', padding: '10px 120px 14px 18px', display: 'flex', gap: 8, alignItems: 'flex-end' },
      textarea: {
        flex: '1 1 auto',
        resize: 'none',
        minHeight: 38,
        maxHeight: 140,
        padding: '8px 11px',
        fontSize: 13,
        lineHeight: 1.5,
        borderRadius: 9,
        border: '1px solid rgba(128,128,128,.38)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      send: {
        padding: '8px 16px',
        fontSize: 13,
        borderRadius: 9,
        border: '1px solid rgba(59,130,246,.55)',
        background: 'rgba(59,130,246,.18)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
      },
      input: {
        padding: '4px 9px',
        fontSize: 12,
        borderRadius: 7,
        border: '1px solid rgba(128,128,128,.38)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      err: { color: '#ef4444', fontSize: 12, padding: '6px 18px 0' },
      empty: { opacity: 0.5, fontSize: 12, margin: 'auto', textAlign: 'center' },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      dialog: {
        width: 340,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 64px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        borderRadius: 14,
        background: '#232323',
        color: '#eee',
        border: '1px solid rgba(255,255,255,.12)',
        boxShadow: '0 18px 48px rgba(0,0,0,.55)',
      },
      dTitle: { fontSize: 13, fontWeight: 600 },
      dLabel: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      dHint: { fontSize: 11, opacity: 0.55 },
      dList: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        overflowY: 'auto',
        maxHeight: 220,
        padding: '2px 0',
      },
      dFoot: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
      note: { opacity: 0.55, fontSize: 11, padding: '4px 18px 0' },
    };

    function Message(props) {
      var m = props.msg;
      var mine = m.from === ME;
      return React.createElement(
        'div',
        { style: Object.assign({}, S.msg, mine ? S.msgMine : null) },
        React.createElement(
          'div',
          { style: S.msgMeta },
          React.createElement('span', { style: { fontWeight: 600 } }, m.from || '?'),
          React.createElement('span', null, hhmm(m.at)),
          m.kind === 'ask' ? React.createElement('span', null, '· 问') : null,
        ),
        React.createElement(
          'div',
          { style: Object.assign({}, S.bubble, mine ? S.bubbleMine : null) },
          m.subject && m.subject !== m.body
            ? React.createElement('div', { style: S.subject }, m.subject)
            : null,
          m.body || m.subject || '（空）',
        ),
      );
    }

    function Panel() {
      var snap = useSnapshot();
      var state = snap[0];
      var refresh = snap[1];
      var [active, setActive] = React.useState('');
      var [draft, setDraft] = React.useState('');
      var [error, setError] = React.useState('');
      var [sending, setSending] = React.useState(false);
      var [creating, setCreating] = React.useState(false);
      var [newName, setNewName] = React.useState('');
      var [picked, setPicked] = React.useState({});
      var [sessions, setSessions] = React.useState([]);
      var [manage, setManage] = React.useState(false);
      var [confirmDel, setConfirmDel] = React.useState(false);
      var [renameTo, setRenameTo] = React.useState(null);
      var listRef = React.useRef(null);

      var data = state.data;
      var groups = (data && data.groups) || [];
      var projects = (data && data.projects) || [];

      // 群被删掉、或者首次进来，自动选一个。
      React.useEffect(
        function () {
          if (groups.length === 0) {
            if (active) setActive('');
            return;
          }
          var found = false;
          for (var i = 0; i < groups.length; i++) if (groups[i].name === active) found = true;
          if (!found) setActive(groups[0].name);
        },
        [data],
      );

      var thread = useThread(active);
      var messages = (thread && thread.messages) || [];

      React.useEffect(
        function () {
          var el = listRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        },
        [messages.length, active],
      );

      var byId = {};
      projects.forEach(function (p) {
        byId[p.id] = p;
      });

      var members = [];
      for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi].name === active) members = groups[gi].members;
      }

      function say() {
        var text = String(draft || '').trim();
        if (!text || !active || sending) return;
        setSending(true);
        setError('');
        postJson('/say', { group: active, text: text })
          .then(function (res) {
            setDraft('');
            setSending(false);
            if (res && res.note) setError('');
            refresh();
          })
          .catch(function (err) {
            setSending(false);
            setError(String((err && err.message) || err));
          });
      }

      function togglePick(item) {
        setPicked(function (prev) {
          var next = Object.assign({}, prev);
          if (next[item.id]) delete next[item.id];
          else next[item.id] = { session: item.session || '', title: item.title || '' };
          return next;
        });
      }

      /** 打开弹窗，顺手拉一次历史会话列表（会话列表要解 zstd，不放进 3 秒轮询里）。 */
      function openCreate() {
        setNewName('');
        setPicked({});
        setCreating(true);
        getJson('/sessions')
          .then(function (r) {
            setSessions((r && r.sessions) || []);
          })
          .catch(function () {
            setSessions([]);
          });
      }

      /** 弹窗里的「创建」：先建群，再逐个把勾中的项目 / 会话拉进去。 */
      function doCreate() {
        var name = String(newName || '').trim();
        if (!name) return;
        var chosen = Object.keys(picked);
        postJson('/group/create', { name: name })
          .then(function (res) {
            var actual = (res && res.name) || name;
            return Promise.all(
              chosen.map(function (id) {
                var p = picked[id] || {};
                return postJson('/group/member', {
                  group: actual,
                  peer: id,
                  action: 'add',
                  session: p.session || '',
                  title: p.title || '',
                }).catch(function () {});
              }),
            ).then(function () {
              return actual;
            });
          })
          .then(function (actual) {
            setCreating(false);
            setNewName('');
            setPicked({});
            setActive(actual);
            setError('');
            refresh();
          })
          .catch(function (err) {
            setError(String((err && err.message) || err));
          });
      }

      function moveMember(id, action) {
        postJson('/group/member', { group: active, peer: id, action: action })
          .then(function () {
            setError('');
            refresh();
          })
          .catch(function (err) {
            setError(String((err && err.message) || err));
          });
      }

      /** 删群要点两下 —— 群里的聊天记录会一起没，不给一次误触的机会。 */
      function deleteGroup() {
        if (!confirmDel) {
          setConfirmDel(true);
          return;
        }
        postJson('/group/delete', { name: active })
          .then(function () {
            setConfirmDel(false);
            setActive('');
            setError('');
            refresh();
          })
          .catch(function (err) {
            setConfirmDel(false);
            setError(String((err && err.message) || err));
          });
      }

      function commitRename() {
        var next = String(renameTo || '').trim();
        if (!next || next === active) {
          setRenameTo(null);
          return;
        }
        postJson('/group/rename', { name: active, to: next })
          .then(function () {
            setActive(next);
            setRenameTo(null);
            setError('');
            refresh();
          })
          .catch(function (err) {
            setRenameTo(null);
            setError(String((err && err.message) || err));
          });
      }

      if (state.loading && !data) {
        return React.createElement('div', { style: S.page }, React.createElement('div', { style: S.empty }, '正在读 agent-bus…'));
      }

      if (!data) {
        return React.createElement(
          'div',
          { style: S.page },
          React.createElement('div', { style: S.head }, React.createElement('div', { style: S.h1 }, '群组')),
          React.createElement('div', { style: S.err }, state.error || '读不到 agent-bus'),
        );
      }

      var inGroup = {};
      members.forEach(function (m) {
        inGroup[m] = true;
      });
      var outsiders = projects.filter(function (p) {
        return !inGroup[p.id];
      });

      return React.createElement(
        'div',
        { style: S.page },
        React.createElement(
          'div',
          { style: S.head },
          React.createElement(
            'div',
            { style: S.title },
            React.createElement('span', { style: S.h1 }, active ? '#' + active : '群组'),
            React.createElement(
              'span',
              { style: S.sub },
              active ? members.length + ' 个成员 · ' + messages.length + ' 条消息' : groups.length + ' 个群组',
            ),
            React.createElement(
              'button',
              {
                style: Object.assign({}, S.chip, { marginLeft: 'auto', opacity: 0.8 }),
                onClick: function () {
                  setManage(!manage);
                },
              },
              manage ? '收起' : '管理',
            ),
          ),
          React.createElement(
            'div',
            { style: S.groups },
            groups.map(function (g) {
              return React.createElement(
                'button',
                {
                  key: g.name,
                  style: Object.assign({}, S.gtab, g.name === active ? S.gtabOn : null),
                  onClick: function () {
                    setActive(g.name);
                  },
                },
                '#' + g.name + ' ' + g.members.length,
              );
            }),
            React.createElement(
              'button',
              {
                style: Object.assign({}, S.gtab, { borderStyle: 'dashed', opacity: 0.9 }),
                onClick: openCreate,
              },
              '＋ 新群',
            ),
          ),
          manage && active
            ? React.createElement(
                'div',
                { style: S.members },
                members.map(function (id) {
                  var p = byId[id] || { id: id, phase: 'unknown', now: '' };
                  var isSession = p.role === 'session';
                  var label = isSession ? p.title || id : id;
                  return React.createElement(
                    'button',
                    {
                      key: id,
                      style: S.chip,
                      title:
                        (isSession ? '会话：' + (p.session || '') + '\n' : '项目：' + (p.path || '') + '\n') +
                        (p.now || '') +
                        '（点一下移出）',
                      onClick: function () {
                        moveMember(id, 'remove');
                      },
                    },
                    React.createElement('span', {
                      style: Object.assign({}, S.dot, { background: PHASE_COLOR[p.phase] || PHASE_COLOR.unknown }),
                    }),
                    (isSession ? '💬 ' : '') + label,
                    React.createElement('span', { style: { opacity: 0.5 } }, phaseLabel(p.phase)),
                  );
                }),
                outsiders.map(function (p) {
                  return React.createElement(
                    'button',
                    {
                      key: p.id,
                      style: Object.assign({}, S.chip, S.addChip),
                      title: p.path,
                      onClick: function () {
                        moveMember(p.id, 'add');
                      },
                    },
                    '+ ' + p.id,
                  );
                }),
                React.createElement(
                  'span',
                  { style: { display: 'inline-flex', gap: 8, alignItems: 'center', marginLeft: 'auto' } },
                  renameTo === null
                    ? React.createElement(
                        'button',
                        {
                          style: Object.assign({}, S.chip, { opacity: 0.8 }),
                          onClick: function () {
                            setRenameTo(active);
                          },
                        },
                        '改名',
                      )
                    : React.createElement('input', {
                        style: Object.assign({}, S.input, { width: 100 }),
                        value: renameTo,
                        autoFocus: true,
                        onChange: function (e) {
                          setRenameTo(e.target.value);
                        },
                        onKeyDown: function (e) {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setRenameTo(null);
                        },
                      }),
                  React.createElement(
                    'button',
                    {
                      style: Object.assign({}, S.chip, {
                        color: '#ef4444',
                        borderColor: 'rgba(239,68,68,.5)',
                      }),
                      onClick: deleteGroup,
                    },
                    confirmDel ? '真的删？再点一次' : '删群',
                  ),
                  confirmDel
                    ? React.createElement(
                        'button',
                        {
                          style: S.chip,
                          onClick: function () {
                            setConfirmDel(false);
                          },
                        },
                        '取消',
                      )
                    : null,
                ),
              )
            : null,
        ),
        state.error || error ? React.createElement('div', { style: S.err }, state.error || error) : null,
        React.createElement(
          'div',
          { style: S.list, ref: listRef },
          !active
            ? React.createElement('div', { style: S.empty }, '还没有群组。上面输入一个名字回车就建好了。')
            : messages.length === 0
              ? React.createElement('div', { style: S.empty }, '这个群还没有说过话。在下面说一句，成员会各自回。')
              : messages.map(function (m) {
                  return React.createElement(Message, { key: m.id, msg: m });
                }),
        ),
        active
          ? React.createElement(
              'div',
              { style: S.composer },
              React.createElement('textarea', {
                style: S.textarea,
                value: draft,
                placeholder: '在 #' + active + ' 里说点什么…（Enter 发送，Shift+Enter 换行）',
                onChange: function (e) {
                  setDraft(e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    say();
                  }
                },
              }),
              React.createElement(
                'button',
                { style: Object.assign({}, S.send, sending ? { opacity: 0.5 } : null), onClick: say, disabled: sending },
                sending ? '发送中…' : '发送',
              ),
            )
          : null,
        creating
          ? React.createElement(
              'div',
              {
                style: S.overlay,
                onMouseDown: function (e) {
                  if (e.target === e.currentTarget) setCreating(false);
                },
              },
              React.createElement(
                'div',
                { style: S.dialog },
                React.createElement('div', { style: S.dTitle }, '新建群组'),
                React.createElement('input', {
                  style: Object.assign({}, S.input, {
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 14,
                    padding: '8px 10px',
                  }),
                  placeholder: '群名，比如 overlay-pipeline',
                  value: newName,
                  autoFocus: true,
                  onChange: function (e) {
                    setNewName(e.target.value);
                  },
                  onKeyDown: function (e) {
                    if (e.key === 'Escape') setCreating(false);
                    if (e.key === 'Enter' && String(newName || '').trim()) doCreate();
                  },
                }),
                React.createElement(
                  'div',
                  { style: S.dHint },
                  '选成员（已选 ' + Object.keys(picked).length + ' 个，可以先不选，之后再加）',
                ),
                React.createElement('div', { style: S.dLabel }, '项目'),
                React.createElement(
                  'div',
                  { style: S.dList },
                  projects.length === 0
                    ? React.createElement('div', { style: S.empty }, '工作区里没发现项目')
                    : projects.map(function (p) {
                        var on = !!picked[p.id];
                        return React.createElement(
                          'button',
                          {
                            key: p.id,
                            style: Object.assign({}, S.chip, on ? S.chipOn : null, { maxWidth: '100%' }),
                            title: p.path,
                            onClick: function () {
                              togglePick(p);
                            },
                          },
                          (on ? '✓ ' : '') + p.id,
                        );
                      }),
                ),
                React.createElement('div', { style: S.dLabel }, '会话'),
                React.createElement(
                  'div',
                  { style: S.dList },
                  sessions.length === 0
                    ? React.createElement('div', { style: S.empty }, '没读到历史会话')
                    : sessions.map(function (s) {
                        var on = !!picked[s.id];
                        return React.createElement(
                          'button',
                          {
                            key: s.id,
                            style: Object.assign({}, S.chip, on ? S.chipOn : null, { maxWidth: '100%' }),
                            title: (s.title || '') + '\n' + (s.session || '') + '\n' + (s.cwd || ''),
                            onClick: function () {
                              togglePick(s);
                            },
                          },
                          (on ? '✓ ' : '') + (s.title || s.id),
                        );
                      }),
                ),
                React.createElement(
                  'div',
                  { style: S.dFoot },
                  React.createElement(
                    'button',
                    {
                      style: S.chip,
                      onClick: function () {
                        setCreating(false);
                      },
                    },
                    '取消',
                  ),
                  React.createElement(
                    'button',
                    {
                      style: Object.assign({}, S.send, {
                        padding: '6px 16px',
                        opacity: String(newName || '').trim() ? 1 : 0.4,
                      }),
                      disabled: !String(newName || '').trim(),
                      onClick: doCreate,
                    },
                    '创建',
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        var disposers = [];
        disposers.push(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 6,
                label: function () {
                  return '群组';
                },
              },
              Icon,
            );
          }),
        );
        disposers.push(
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel);
          }),
        );
        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try {
              disposers[i]();
            } catch (e) {
              /* 释放失败不影响卸载 */
            }
          }
        };
      }, 'agent-bus-ui: sidebar + panel');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
