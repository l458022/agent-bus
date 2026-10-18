/**
 * dsh-plugin-agent-bus · client 半边
 *
 * 左侧栏一个「群组」入口（sidebar.panellist），中间栏一个全局面板（main）。
 * 数据全部来自 host 的 /api/agent-bus/snapshot —— 不自己存任何东西。
 *
 * 面板能做的：建群、删群、改名、把工作区里的项目拉进/移出群。
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
      page: { padding: '18px 20px 48px', maxWidth: 820, fontSize: 13, lineHeight: 1.55 },
      h1: { fontSize: 15, fontWeight: 600, margin: '0 0 2px' },
      sub: { opacity: 0.55, fontSize: 12, marginBottom: 14 },
      bar: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16 },
      input: {
        flex: '0 1 240px',
        padding: '5px 9px',
        fontSize: 12,
        borderRadius: 7,
        border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      btn: {
        padding: '5px 11px',
        fontSize: 12,
        borderRadius: 7,
        border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      groupName: { fontWeight: 600, fontSize: 13 },
      count: { opacity: 0.55, fontSize: 12, marginRight: 'auto' },
      row: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' },
      dot: { width: 7, height: 7, borderRadius: 99, flex: '0 0 auto', transform: 'translateY(-1px)' },
      peer: { fontWeight: 500, minWidth: 130 },
      path: { opacity: 0.42, fontSize: 11, minWidth: 100 },
      phase: { fontSize: 12, opacity: 0.7, minWidth: 34 },
      now: { opacity: 0.62, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      actions: { marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
      chip: {
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 99,
        padding: '2px 10px',
        fontSize: 12,
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      addChip: { borderStyle: 'dashed', opacity: 0.85 },
      mini: { fontSize: 11, opacity: 0.6, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit' },
      err: { color: '#ef4444', fontSize: 12, marginBottom: 10 },
      empty: { opacity: 0.55, fontSize: 12 },
      hint: { opacity: 0.5, fontSize: 11 },
    };

    function ProjectRow(props) {
      var p = props.project;
      return React.createElement(
        'div',
        { style: S.row },
        React.createElement('span', {
          style: Object.assign({}, S.dot, { background: PHASE_COLOR[p.phase] || PHASE_COLOR.unknown }),
        }),
        React.createElement('span', { style: S.peer }, p.id),
        React.createElement('span', { style: S.path }, p.path === p.id ? '' : p.path),
        React.createElement('span', { style: S.phase }, phaseLabel(p.phase)),
        React.createElement('span', { style: S.now, title: p.now }, p.now || '—'),
        props.onRemove
          ? React.createElement('button', { style: Object.assign({}, S.mini, { marginLeft: 'auto' }), onClick: props.onRemove, title: '移出这个群' }, '移出')
          : null,
      );
    }

    function GroupCard(props) {
      var group = props.group;
      var projects = props.projects;
      var onChanged = props.onChanged;
      var [busy, setBusy] = React.useState('');
      var [renaming, setRenaming] = React.useState(null);

      var inGroup = {};
      group.members.forEach(function (m) {
        inGroup[m] = true;
      });

      function byId(id) {
        for (var i = 0; i < projects.length; i++) {
          if (projects[i].id === id) return projects[i];
        }
        return { id: id, path: id, phase: 'unknown', now: '' };
      }

      function move(id, action) {
        setBusy(id);
        postJson('/group/member', { group: group.name, peer: id, action: action })
          .then(function () {
            setBusy('');
            onChanged('');
          })
          .catch(function (err) {
            setBusy('');
            onChanged(String((err && err.message) || err));
          });
      }

      function removeGroup() {
        setBusy('__group__');
        postJson('/group/delete', { name: group.name })
          .then(function () {
            setBusy('');
            onChanged('');
          })
          .catch(function (err) {
            setBusy('');
            onChanged(String((err && err.message) || err));
          });
      }

      function commitRename() {
        var next = String(renaming || '').trim();
        if (!next || next === group.name) {
          setRenaming(null);
          return;
        }
        setBusy('__group__');
        postJson('/group/rename', { name: group.name, to: next })
          .then(function () {
            setBusy('');
            setRenaming(null);
            onChanged('');
          })
          .catch(function (err) {
            setBusy('');
            onChanged(String((err && err.message) || err));
          });
      }

      var outsiders = projects.filter(function (p) {
        return !inGroup[p.id];
      });

      return React.createElement(
        'div',
        { style: S.card },
        React.createElement(
          'div',
          { style: S.cardHead },
          renaming === null
            ? React.createElement('span', { style: S.groupName }, '#' + group.name)
            : React.createElement('input', {
                style: Object.assign({}, S.input, { flex: '0 1 160px' }),
                value: renaming,
                autoFocus: true,
                onChange: function (e) {
                  setRenaming(e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                },
              }),
          React.createElement('span', { style: S.count }, group.members.length + ' 个成员'),
          renaming === null
            ? React.createElement(
                'button',
                {
                  style: S.mini,
                  onClick: function () {
                    setRenaming(group.name);
                  },
                },
                '改名',
              )
            : React.createElement('button', { style: S.mini, onClick: commitRename }, '保存'),
          React.createElement('button', { style: Object.assign({}, S.mini, { color: '#ef4444' }), disabled: busy === '__group__', onClick: removeGroup }, '删群'),
        ),
        group.members.length
          ? group.members.map(function (id) {
              return React.createElement(ProjectRow, {
                key: id,
                project: byId(id),
                onRemove: function () {
                  move(id, 'remove');
                },
              });
            })
          : React.createElement('div', { style: S.empty }, '空群。从下面挑项目拉进来。'),
        outsiders.length
          ? React.createElement(
              'div',
              { style: S.actions },
              React.createElement('span', { style: S.hint }, '拉进来：'),
              outsiders.map(function (p) {
                return React.createElement(
                  'button',
                  {
                    key: p.id,
                    style: Object.assign({}, S.chip, S.addChip),
                    disabled: busy === p.id,
                    onClick: function () {
                      move(p.id, 'add');
                    },
                    title: p.path,
                  },
                  '+ ' + p.id,
                );
              }),
            )
          : null,
      );
    }

    function Page() {
      var snap = useSnapshot();
      var state = snap[0];
      var refresh = snap[1];
      var [error, setError] = React.useState('');
      var [draft, setDraft] = React.useState('');

      function changed(msg) {
        if (typeof msg === 'string' && msg) setError(msg);
        else setError('');
        refresh();
      }

      function createGroup() {
        var name = String(draft || '').trim();
        if (!name) return;
        postJson('/group/create', { name: name })
          .then(function () {
            setDraft('');
            changed('');
          })
          .catch(function (err) {
            changed(String((err && err.message) || err));
          });
      }

      var data = state.data;

      if (state.loading && !data) {
        return React.createElement('div', { style: S.page }, React.createElement('div', { style: S.empty }, '正在读 agent-bus…'));
      }

      if (!data) {
        return React.createElement(
          'div',
          { style: S.page },
          React.createElement('div', { style: S.h1 }, '群组'),
          React.createElement('div', { style: S.err }, state.error || '读不到 agent-bus'),
        );
      }

      var loose = data.projects.filter(function (p) {
        return !data.groups.some(function (g) {
          return g.members.indexOf(p.id) >= 0;
        });
      });

      return React.createElement(
        'div',
        { style: S.page },
        React.createElement('div', { style: S.h1 }, '群组'),
        React.createElement('div', { style: S.sub }, data.projects.length + ' 个项目 · ' + data.groups.length + ' 个群组 · ' + POLL_MS / 1000 + ' 秒刷新'),
        React.createElement(
          'div',
          { style: S.bar },
          React.createElement('input', {
            style: S.input,
            value: draft,
            placeholder: '新群组名字，比如 frontend',
            onChange: function (e) {
              setDraft(e.target.value);
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter') createGroup();
            },
          }),
          React.createElement('button', { style: S.btn, onClick: createGroup }, '新建群组'),
        ),
        state.error || error ? React.createElement('div', { style: S.err }, state.error || error) : null,
        data.groups.length
          ? data.groups.map(function (g) {
              return React.createElement(GroupCard, { key: g.name, group: g, projects: data.projects, onChanged: changed });
            })
          : React.createElement('div', { style: S.card }, React.createElement('div', { style: S.empty }, '还没有群组，上面建一个。')),
        loose.length
          ? React.createElement(
              'div',
              { style: S.card },
              React.createElement(
                'div',
                { style: S.cardHead },
                React.createElement('span', { style: S.groupName }, '还没进任何群'),
                React.createElement('span', { style: S.count }, loose.length + ' 个项目'),
              ),
              loose.map(function (p) {
                return React.createElement(ProjectRow, { key: p.id, project: p });
              }),
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
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, Page);
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
